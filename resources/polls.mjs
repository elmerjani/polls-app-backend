import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const POLLS_TABLE = process.env.POLLS_TABLE;

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocumentClient.from(client);

const includeHeader = (response) => {
  return {
    ...response,
    headers: {
      ...(response.headers || {}),
      "Access-Control-Allow-Origin": "*",
    },
  };
};
export const createPollHandler = async (event) => {
  try {
    const claims = event.requestContext.authorizer.claims;
    const userEmail = claims.email;
    const userName = claims.name || userEmail;

    const body = JSON.parse(event.body);
    const { question, options } = body;

    if (
      !question ||
      !options ||
      !Array.isArray(options) ||
      options.length === 0
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Invalid input" }),
      };
    }

    const pollId = uuidv4();
    const createdAt = new Date().toISOString();

    // Build batch items: poll + options
    const items = [
      {
        PutRequest: {
          Item: {
            PK: `POLL#${pollId}`,
            SK: "POLL",
            pollId,
            question,
            owner: {
              email: userEmail,
              name: userName,
            },
            createdAt,
            GSI1PK: "POLL",
            GSI2PK: `OWNER#${userEmail}`,
          },
        },
      },
      ...options.map((opt, i) => ({
        PutRequest: {
          Item: {
            PK: `POLL#${pollId}`,
            SK: `OPTION#${i + 1}`,
            optionId: i + 1,
            text: opt,
            votesCount: 0,
          },
        },
      })),
    ];

    await ddbDocClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [POLLS_TABLE]: items,
        },
      })
    );

    return {
      statusCode: 201,
      body: JSON.stringify({ pollId, message: "Poll created successfully" }),
    };
  } catch (error) {
    console.error("Error creating poll:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Failed to create poll",
        error: error.message,
      }),
    };
  }
};

export const getPollHandler = async (event) => {
  try {
    const pollId = event.pathParameters.pollId;
    if (!pollId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Missing pollId" }),
      };
    }

    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `POLL#${pollId}` },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Poll not found" }),
      };
    }

    // Extract the poll item
    const pollItem = result.Items.find((item) => item.SK === "POLL");

    // Extract options
    const options = result.Items.filter((item) =>
      item.SK.startsWith("OPTION#")
    ).map((opt) => ({
      id: opt.optionId,
      text: opt.text,
      votesCount: opt.votesCount,
    }));
    const votesResult = result.Items.filter((i) =>
      i.SK.startsWith("VOTE#")
    ).map((vote) => ({
      user: vote.user,
      optionId: vote.optionId,
      createdAt: vote.createdAt,
    }));

    const poll = {
      pollId: pollItem.pollId,
      question: pollItem.question,
      createdAt: pollItem.createdAt,
      owner: pollItem.owner,
      options,
      votes: votesResult,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(poll),
    };
  } catch (error) {
    console.error("Error fetching poll:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Failed to fetch poll",
        error: error.message,
      }),
    };
  }
};

export const listPollsHandler = async (event) => {
  try {
    // 👇 Extract pagination & sorting params from querystring
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit || "10", 10);
    const sortBy = "createdAt";
    const lastKey = params.lastKey ? JSON.parse(params.lastKey) : undefined;

    const indexName = "PollsByCreatedAt-index";

    // 1️⃣ Query polls from GSI
    const pollsResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        IndexName: indexName,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {
          ":pk": "POLL",
        },
        Limit: limit,
        ExclusiveStartKey: lastKey,
        ScanIndexForward: false,
      })
    );

    const polls = [];

    for (const pollItem of pollsResult.Items) {
      const pollId = pollItem.pollId;

      const optionsResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: POLLS_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `POLL#${pollId}`,
            ":skPrefix": "OPTION#",
          },
        })
      );

      const options =
        optionsResult.Items.map((opt) => ({
          id: opt.optionId,
          text: opt.text,
          votesCount: opt.votesCount,
        })) || [];

      polls.push({
        pollId,
        question: pollItem.question,
        createdAt: pollItem.createdAt,
        owner: pollItem.owner,
        options,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: polls,
        lastKey: pollsResult.LastEvaluatedKey || null,
      }),
    };
  } catch (error) {
    console.error("Error listing polls:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Failed to fetch polls",
        error: error.message,
      }),
    };
  }
};

export const authListPolls = async (event) => {
  try {
    const userEmail = event.requestContext.authorizer?.claims?.email;

    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit || "10", 10);
    const lastKey = params.lastKey ? JSON.parse(params.lastKey) : undefined;

    const indexName = "PollsByCreatedAt-index";
    const pollsResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        IndexName: indexName,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": "POLL" },
        Limit: limit,
        ExclusiveStartKey: lastKey,
        ScanIndexForward: false,
      })
    );

    const polls = [];

    for (const pollItem of pollsResult.Items) {
      const pollId = pollItem.pollId;
      const optionsResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: POLLS_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `POLL#${pollId}`,
            ":skPrefix": "OPTION#",
          },
        })
      );

      const options =
        optionsResult.Items.map((opt) => ({
          id: opt.optionId,
          text: opt.text,
          votesCount: opt.votesCount,
        })) || [];
      const userVote = await ddbDocClient.send(
        new GetCommand({
          TableName: POLLS_TABLE,
          Key: { PK: `POLL#${pollId}`, SK: `VOTE#${userEmail}` },
        })
      );

      polls.push({
        pollId,
        question: pollItem.question,
        createdAt: pollItem.createdAt,
        owner: pollItem.owner,
        options,
        userOption: userVote?.Item?.optionId,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: polls,
        lastKey: pollsResult.LastEvaluatedKey || null,
      }),
    };
  } catch (err) {
    console.error("Error fetching authenticated polls:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

export const authGetPoll = async (event) => {
  try {
    const claims = event.requestContext.authorizer.claims;
    const userEmail = claims.email;

    const pollId = event.pathParameters.pollId;

    // 1️⃣ Query all items for this poll
    const result = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `POLL#${pollId}` },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Poll not found" }),
      };
    }

    const pollItem = result.Items.find((i) => i.SK === "POLL");

    const options = result.Items.filter((i) => i.SK.startsWith("OPTION#")).map(
      (opt) => ({
        id: opt.optionId,
        text: opt.text,
        votesCount: opt.votesCount,
      })
    );
    const votesResult = result.Items.filter((i) =>
      i.SK.startsWith("VOTE#")
    ).map((vote) => ({
      user: vote.user,
      optionId: vote.optionId,
      createdAt: vote.createdAt,
    }));
    const userVote = await ddbDocClient.send(
      new GetCommand({
        TableName: POLLS_TABLE,
        Key: { PK: `POLL#${pollId}`, SK: `VOTE#${userEmail}` },
      })
    );

    const poll = {
      pollId,
      question: pollItem.question,
      createdAt: pollItem.createdAt,
      owner: pollItem.owner,
      options,
      votes: votesResult,
      userOption: userVote?.Item?.optionId,
    };

    return { statusCode: 200, body: JSON.stringify(poll) };
  } catch (err) {
    console.error("Error fetching authenticated poll:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

export const deletePollHandler = async (event) => {
  try {
    const userId = event.requestContext.authorizer.claims.email;
    const pollId = event.pathParameters.pollId;

    // 1️⃣ Fetch poll
    const poll = await ddbDocClient.send(
      new GetCommand({
        TableName: POLLS_TABLE,
        Key: { PK: `POLL#${pollId}`, SK: "POLL" },
      })
    );

    if (!poll.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Poll not found" }),
      };
    }

    // 2️⃣ Check ownership
    if (poll.Item.owner.email !== userId) {
      return {
        statusCode: 403,
        body: JSON.stringify({ message: "You are not the owner of this poll" }),
      };
    }

    // 3️⃣ Query all items belonging to poll (options + votes + poll)
    const pollItems = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `POLL#${pollId}` },
      })
    );

    if (!pollItems.Items || pollItems.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "No items found for this poll" }),
      };
    }

    // 4️⃣ Batch delete all items
    const deleteRequests = pollItems.Items.map((item) => ({
      DeleteRequest: {
        Key: { PK: item.PK, SK: item.SK },
      },
    }));

    // DynamoDB BatchWrite supports max 25 items per call
    while (deleteRequests.length > 0) {
      const chunk = deleteRequests.splice(0, 25);
      await ddbDocClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [POLLS_TABLE]: chunk,
          },
        })
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Poll deleted successfully" }),
    };
  } catch (err) {
    console.error("Error deleting poll:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Failed to delete poll",
        error: err.message,
      }),
    };
  }
};

export const getMyPollsHandler = async (event) => {
  try {
    const userEmail = event.requestContext.authorizer?.claims?.email;
    if (!userEmail) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit || "10", 10);
    const lastKey = params.lastKey ? JSON.parse(params.lastKey) : undefined;

    // Query polls owned by this user
    const pollsResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        IndexName: "PollsByOwner-index",
        KeyConditionExpression: "GSI2PK = :owner",
        ExpressionAttributeValues: { ":owner": `OWNER#${userEmail}` },
        Limit: limit,
        ExclusiveStartKey: lastKey,
        ScanIndexForward: false, // newest first
      })
    );

    const polls = [];
    for (const pollItem of pollsResult.Items) {
      const pollId = pollItem.pollId;

      // Fetch options
      const optionsResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: POLLS_TABLE,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": `POLL#${pollId}`,
            ":skPrefix": "OPTION#",
          },
        })
      );

      const options = optionsResult.Items.map((opt) => ({
        id: opt.optionId,
        text: opt.text,
        votesCount: opt.votesCount,
      }));

      // Fetch user vote for this poll
      const userVote = await ddbDocClient.send(
        new GetCommand({
          TableName: POLLS_TABLE,
          Key: { PK: `POLL#${pollId}`, SK: `VOTE#${userEmail}` },
        })
      );

      polls.push({
        pollId,
        question: pollItem.question,
        createdAt: pollItem.createdAt,
        owner: pollItem.owner,
        options,
        userOption: userVote?.Item?.optionId || null,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: polls,
        lastKey: pollsResult.LastEvaluatedKey || null,
      }),
    };
  } catch (err) {
    console.error("Error fetching polls by owner:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
// Main dispatcher
export const pollsHandler = async (event) => {
  if (event.httpMethod === "POST") {
    return includeHeader(await createPollHandler(event));
  }

  if (event.httpMethod === "GET" && event.resource === "/polls") {
    return includeHeader(await listPollsHandler(event));
  }

  if (event.httpMethod === "GET" && event.resource === "/polls/{pollId}") {
    return includeHeader(await getPollHandler(event));
  }

  if (event.httpMethod === "GET" && event.resource === "/pollsAuth") {
    return includeHeader(await authListPolls(event));
  }

  if (event.httpMethod === "GET" && event.resource === "/pollsAuth/{pollId}") {
    return includeHeader(await authGetPoll(event));
  }
  if (event.httpMethod === "DELETE" && event.resource === "/polls/{pollId}") {
    return includeHeader(await deletePollHandler(event));
  }
  if (event.httpMethod === "GET" && event.resource === "/myPolls") {
    return includeHeader(await getMyPollsHandler(event));
  }

  return includeHeader({
    statusCode: 400,
    body: JSON.stringify({ error: "Unsupported route" }),
  });
};

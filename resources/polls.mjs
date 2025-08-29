import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchWriteCommand,
  ScanCommand,
  GetCommand
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

    const poll = {
      pollId: pollItem.pollId,
      question: pollItem.question,
      createdAt: pollItem.createdAt,
      owner: pollItem.owner,
      options,
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

export const listPollsHandler = async () => {
  try {
    // 1️⃣ Scan to get all polls (SK = "POLL")
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: POLLS_TABLE,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": "POLL" },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return { statusCode: 200, body: JSON.stringify([]) };
    }

    const polls = [];

    // 2️⃣ For each poll, query its options
    for (const pollItem of result.Items) {
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
      body: JSON.stringify(polls),
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
    

    // 1️⃣ Scan polls (SK = "POLL")
    const result = await ddbDocClient.send(
      new ScanCommand({
        TableName: POLLS_TABLE,
        FilterExpression: "SK = :sk",
        ExpressionAttributeValues: { ":sk": "POLL" },
      })
    );

    const polls = [];

    for (const pollItem of result.Items) {
      const pollId = pollItem.pollId;

      // 2️⃣ Query poll options
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
       
      // 3️⃣ Get user vote (userOption)
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
        userOption: userVote?.Item?.optionId, // undefined if user didn't vote
      });
    }

    return { statusCode: 200, body: JSON.stringify(polls) };
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
      return { statusCode: 404, body: JSON.stringify({ message: "Poll not found" }) };
    }

    const pollItem = result.Items.find((i) => i.SK === "POLL");

    const options = result.Items
      .filter((i) => i.SK.startsWith("OPTION#"))
      .map((opt) => ({
        id: opt.optionId,
        text: opt.text,
        votesCount: opt.votesCount,
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
      userOption: userVote?.Item?.optionId,
    };

    return { statusCode: 200, body: JSON.stringify(poll) };
  } catch (err) {
    console.error("Error fetching authenticated poll:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
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
    return includeHeader(await authListPolls(event))
  }

  if (event.httpMethod === "GET" && event.resource === "/pollsAuth/{pollId}") {
    return includeHeader(await authGetPoll(event))
  }

  return includeHeader({
    statusCode: 400,
    body: JSON.stringify({ error: "Unsupported route" }),
  });
};

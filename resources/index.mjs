import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocumentClient.from(client);

// CREATE poll
const createPollHandler = async (event) => {
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing request body" }),
    };
  }

  const body = JSON.parse(event.body);

  const pollId = uuidv4();
  const params = new PutCommand({
    TableName: process.env.POLLS_TABLE,
    Item: {
      PK: "POLL",
      pollId,
      question: body.question,
      options: body.options,
      createdBy: body.createdBy || "anonymous",
      createdAt: new Date().toISOString(),
    },
  });

  await ddbDocClient.send(params);

  return {
    statusCode: 201,
    body: JSON.stringify({ pollId, message: "Poll created successfully" }),
  };
};

// LIST polls (with pagination & sorting)
const listPollsHandler = async (event) => {
  try {
    const queryParams = event.queryStringParameters || {};
    const limit = parseInt(queryParams.limit || "10");
    const lastKey = queryParams.lastKey
      ? JSON.parse(decodeURIComponent(queryParams.lastKey))
      : undefined;
    const sortOrder = queryParams.sortOrder === "asc"; // default desc

    const command = new QueryCommand({
      TableName: process.env.POLLS_TABLE,
      IndexName: "PollsByCreatedAt",
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "POLL" },
      Limit: limit,
      ExclusiveStartKey: lastKey,
      ScanIndexForward: sortOrder,
    });

    const result = await ddbDocClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: result.Items,
        lastKey: result.LastEvaluatedKey
          ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey))
          : null,
      }),
    };
  } catch (err) {
    console.error("Error listing polls:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch polls" }),
    };
  }
};

// GET poll by ID
const getPollHandler = async (pollId) => {
  try {
    const command = new GetCommand({
      TableName: process.env.POLLS_TABLE,
      Key: { pollId },
    });

    const result = await ddbDocClient.send(command);

    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Poll not found" }),
      };
    }

    return { statusCode: 200, body: JSON.stringify(result.Item) };
  } catch (err) {
    console.error("Error fetching poll:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch poll" }),
    };
  }
};

// Main dispatcher
export const pollsHandler = async (event) => {
  console.log("Event:", JSON.stringify(event, null, 2));

  if (event.httpMethod === "POST") {
    const claims = event.requestContext.authorizer.claims;
    const userEmail = claims.email || claims["cognito:username"];
    const body = JSON.parse(event.body);
    return await createPollHandler({
      ...event,
      body: JSON.stringify({
        ...body,
        createdBy: userEmail, // override createdBy with current user
      }),
    });
  }

  if (event.httpMethod === "GET" && event.resource === "/polls") {
    return await listPollsHandler(event);
  }

  if (event.httpMethod === "GET" && event.resource === "/polls/{pollId}") {
    return await getPollHandler(event);
  }

  return {
    statusCode: 400,
    body: JSON.stringify({ error: "Unsupported route" }),
  };
};

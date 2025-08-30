import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const POLLS_TABLE = process.env.POLLS_TABLE;

// Handle new connections
export const connectHandler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userContext = event.requestContext.authorizer || {};
  const username = userContext.username;
  const email = userContext.email;
  console.log("CONNECT:", connectionId);

  try {
    await ddbDocClient.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          PK: connectionId,
          user: {
            name: username,
            email: email,
          },
        },
      })
    );
  } catch (err) {
    console.log(err);
    return { statusCode: 500 };
  }

  return { statusCode: 200 };
};

// Handle disconnects
export const disconnectHandler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  console.log("DISCONNECT:", connectionId);

  try {
    await ddbDocClient.send(
      new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { PK: connectionId },
      })
    );
  } catch (err) {
    console.log(err);
    return { statusCode: 500 };
  }

  return { statusCode: 200 };
};


export const messagesHandler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { pollId, optionId } = body;
    const connectionId = event.requestContext.connectionId;

    // 1️⃣ Get user info from CONNECTIONS_TABLE
    const conn = await ddbDocClient.send(
      new GetCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { PK: connectionId },
      })
    );

    if (!conn.Item || !conn.Item.user) {
      throw new Error("User not found for this connection");
    }

    const { email: userId, name: userName } = conn.Item.user;
    const createdAt = new Date().toISOString();

    // 2️⃣ Check if user has already voted
    const previousVote = await ddbDocClient.send(
      new GetCommand({
        TableName: POLLS_TABLE,
        Key: { PK: `POLL#${pollId}`, SK: `VOTE#${userId}` },
      })
    );

    // 3️⃣ If user voted before, decrement previous option count
    if (previousVote.Item) {
      await ddbDocClient.send(
        new UpdateCommand({
          TableName: POLLS_TABLE,
          Key: { PK: `POLL#${pollId}`, SK: `OPTION#${previousVote.Item.optionId}` },
          UpdateExpression: "SET votesCount = votesCount - :dec",
          ExpressionAttributeValues: { ":dec": 1 },
        })
      );
    }

    // 4️⃣ Increment new option votesCount
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: POLLS_TABLE,
        Key: { PK: `POLL#${pollId}`, SK: `OPTION#${optionId}` },
        UpdateExpression: "SET votesCount = votesCount + :inc",
        ExpressionAttributeValues: { ":inc": 1 },
      })
    );

    // 5️⃣ Persist user's vote using PutCommand ✅ ensures createdAt is stored
    await ddbDocClient.send(
      new PutCommand({
        TableName: POLLS_TABLE,
        Item: {
          PK: `POLL#${pollId}`,
          SK: `VOTE#${userId}`,
          optionId,
          user: { email: userId, name: userName },
          createdAt, // ✅ now guaranteed to persist
        },
      })
    );

    // 6️⃣ Fetch updated poll options
    const pollResult = await ddbDocClient.send(
      new QueryCommand({
        TableName: POLLS_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `POLL#${pollId}`,
          ":skPrefix": "OPTION#",
        },
      })
    );

    const options = pollResult.Items.map((opt) => ({
      id: Number(opt.SK.split("#")[1]),
      text: opt.text,
      votesCount: opt.votesCount,
    }));

    // 7️⃣ Broadcast updated poll to all connections
    const connections = await ddbDocClient.send(
      new ScanCommand({ TableName: CONNECTIONS_TABLE })
    );

    const callbackAPI = new ApiGatewayManagementApiClient({
      endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
    });

    await Promise.allSettled(
      connections.Items.map(async ({ PK: connId }) => {
        try {
          await callbackAPI.send(
            new PostToConnectionCommand({
              ConnectionId: connId,
              Data: JSON.stringify({
                pollId,
                options,
                user: { name: userName, email: userId },
                createdAt,
              }),
            })
          );
        } catch (err) {
          console.error("Send error:", err);
        }
      })
    );

    return { statusCode: 200 };
  } catch (err) {
    console.error("Error in messagesHandler:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
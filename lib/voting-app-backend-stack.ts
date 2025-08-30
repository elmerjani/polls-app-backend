import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dotenv from "dotenv";
dotenv.config();

export class VotingAppBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table for polls
    const pollsTable = new dynamodb.Table(this, "PollsTable", {
      tableName: "Polls",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    pollsTable.addGlobalSecondaryIndex({
      indexName: "PollsByCreatedAt-index",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    });
    pollsTable.addGlobalSecondaryIndex({
      indexName: "PollsByOwner-index",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING }, // OWNER#<email>
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING }, // for sorting
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    });

    // Table to store active WebSocket connections
    const connectionsTable = new dynamodb.Table(this, "ConnectionsTable", {
      tableName: "Connections",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // lambda layer to include dependencies
    const lambdaLayer = new lambda.LayerVersion(this, "LambdaLayer", {
      layerVersionName: "LambdaLayer",
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      code: lambda.Code.fromAsset("./resources/dependencies/nodejs"),
    });

    // Lambda function to manage polls
    const managePollsLambda = new lambda.Function(this, "managePollsLambda", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset("resources"),
      handler: "polls.pollsHandler",
      environment: {
        POLLS_TABLE: pollsTable.tableName,
      },
      layers: [lambdaLayer],
    });
    pollsTable.grantFullAccess(managePollsLambda);

    // 🔹 WebSocket Lambda Authorizer for Cognito Authentication
    const webSocketAuthorizerLambda = new lambda.Function(
      this,
      "WebSocketAuthorizerLambda",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        code: lambda.Code.fromAsset("resources"),
        handler: "auth.webSocketAuthorizerHandler",
        environment: {
          COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID!,
          COGNITO_REGION: process.env.AWS_REGION || "us-east-1",
        },
        layers: [lambdaLayer],
        timeout: cdk.Duration.seconds(30),
      }
    );

    // websocket lambda functions
    //lambda for handling connection
    const connectLambda = new lambda.Function(this, "ConnectLambda", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset("resources"),
      handler: "votes.connectHandler",
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
      layers: [lambdaLayer],
    });
    connectionsTable.grantReadWriteData(connectLambda);

    // 🔹 Lambda for handling disconnections
    const disconnectLambda = new lambda.Function(this, "DisconnectHandler", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset("resources"),
      handler: "votes.disconnectHandler",
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
      layers: [lambdaLayer],
    });
    connectionsTable.grantReadWriteData(disconnectLambda);

    // 🔹 Lambda for messages (votes, etc.)
    const messageLambda = new lambda.Function(this, "MessageHandler", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset("resources"),
      handler: "votes.messagesHandler",
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        POLLS_TABLE: pollsTable.tableName,
      },
      layers: [lambdaLayer],
    });
    connectionsTable.grantReadData(messageLambda);
    pollsTable.grantFullAccess(messageLambda);

    // 🔹 Create Lambda Authorizer for WebSocket
    const webSocketAuthorizer = new authorizers.WebSocketLambdaAuthorizer(
      "WebSocketAuthorizer",
      webSocketAuthorizerLambda,
      {
        // The authorizer will be invoked on connection
        identitySource: ["route.request.querystring.token"],
      }
    );

    const webSocketApi = new apigatewayv2.WebSocketApi(
      this,
      "PollsWebSocketApi",
      {
        connectRouteOptions: {
          integration: new integrations.WebSocketLambdaIntegration(
            "ConnectIntegration",
            connectLambda
          ),
          authorizer: webSocketAuthorizer, // 🔹 Add authorizer to connect route
        },
        disconnectRouteOptions: {
          integration: new integrations.WebSocketLambdaIntegration(
            "DisconnectIntegration",
            disconnectLambda
          ),
        },
        defaultRouteOptions: {
          integration: new integrations.WebSocketLambdaIntegration(
            "MessageIntegration",
            messageLambda
          ),
        },
      }
    );

    messageLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:aws:execute-api:${cdk.Stack.of(this).region}:${
            cdk.Stack.of(this).account
          }:${webSocketApi.apiId}/*/POST/@connections/*`,
        ],
      })
    );

    const devStage = new apigatewayv2.WebSocketStage(this, "DevStage", {
      webSocketApi,
      stageName: "dev",
      autoDeploy: true,
    });

    // RestAPI Gateway
    const api = new apigateway.RestApi(this, "VotingApi", {
      restApiName: "Voting Service",
      description: "This service handles polls for the Voting App",
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // aws cognito
    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "ImportedUserPool",
      process.env.COGNITO_USER_POOL_ID!
    );

    // authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "PollsAuthorizer",
      {
        cognitoUserPools: [userPool],
      }
    );

    const authenticatedUsersPolls = api.root.addResource("pollsAuth");
    authenticatedUsersPolls.addMethod(
      "GET",
      new apigateway.LambdaIntegration(managePollsLambda),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO }
    );
    const authenticatedUsersPoll =
      authenticatedUsersPolls.addResource("{pollId}");
    authenticatedUsersPoll.addMethod(
      "GET",
      new apigateway.LambdaIntegration(managePollsLambda),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO }
    );

    const myPolls = api.root.addResource("myPolls");
    myPolls.addMethod(
      "GET",
      new apigateway.LambdaIntegration(managePollsLambda),
      {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );
    const polls = api.root.addResource("polls");
    const poll = polls.addResource("{pollId}");
    polls.addMethod(
      "POST",
      new apigateway.LambdaIntegration(managePollsLambda),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO }
    );
    polls.addMethod("GET", new apigateway.LambdaIntegration(managePollsLambda));
    poll.addMethod("GET", new apigateway.LambdaIntegration(managePollsLambda));
    poll.addMethod(
      "DELETE",
      new apigateway.LambdaIntegration(managePollsLambda),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO }
    );

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: api.url,
    });
    new cdk.CfnOutput(this, "websocketEndpoint", {
      value: `${webSocketApi.apiEndpoint}/${devStage.stageName}`,
    });
  }
}

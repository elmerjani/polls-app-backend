import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
export class VotingAppBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB table
    const pollsTable = new dynamodb.Table(this, "PollsTable", {
      tableName: "Polls",
      partitionKey: { name: "pollId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    pollsTable.addGlobalSecondaryIndex({
      indexName: "PollsByCreatedAt",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
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
      handler: "index.pollsHandler",
      environment: {
        POLLS_TABLE: pollsTable.tableName,
      },
      layers: [lambdaLayer],
    });

    // Grant Lambda permission to read and write to DynamoDB
    pollsTable.grantFullAccess(managePollsLambda);

    // API Gateway
    const api = new apigateway.RestApi(this, "VotingApi", {
      restApiName: "Voting Service",
      description: "This service handles polls for the Voting App",
    });
    // aws cognito
    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "ImportedUserPool",
      "us-east-1_ReN3dLLGQ"
    );
    // authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "PollsAuthorizer",
      {
        cognitoUserPools: [userPool],
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
  }
}

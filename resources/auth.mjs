// resources/auth.js
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Cache JWKS client
const client = jwksClient({
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 5,
  jwksUri: `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`
});

// Get signing key from JWKS
const getKey = (header, callback) => {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
};

// Verify JWT token
const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getKey, {
      audience: process.env.COGNITO_CLIENT_ID, // Optional: verify audience
      issuer: `https://cognito-idp.${process.env.COGNITO_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      algorithms: ['RS256']
    }, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded);
      }
    });
  });
};

// Generate IAM policy
const generatePolicy = (principalId, effect, resource, context = {}) => {
  const authResponse = {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context, // Add user context for use in other Lambda functions
  };

  return authResponse;
};

export const webSocketAuthorizerHandler = async (event) => {
  console.log('WebSocket Authorizer Event:', JSON.stringify(event, null, 2));

  try {
    // Extract token from query string
    const token = event.queryStringParameters?.token;
    
    if (!token) {
      console.log('No token provided');
      throw new Error('Unauthorized: No token provided');
    }

    console.log('Verifying token...');
    
    // Verify the JWT token
    const decoded = await verifyToken(token);
    console.log('Token verified successfully:', decoded);

    // Extract user information
    const userId = decoded.sub;
    const username = decoded.name
    const email = decoded.email;

    // Generate allow policy
    const policy = generatePolicy(
      userId,
      'Allow',
      event.methodArn,
      {
        userId,
        username,
        email,
        // Add any other user context you need
      }
    );

    console.log('Generated policy:', JSON.stringify(policy, null, 2));
    return policy;

  } catch (error) {
    console.error('Authorization failed:', error);
    
    // Generate deny policy
    return generatePolicy(
      'user',
      'Deny',
      event.methodArn
    );
  }
};

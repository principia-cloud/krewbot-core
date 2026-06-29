import * as http from "node:http";

const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

export function handleAuthConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      userPoolId: COGNITO_USER_POOL_ID,
      clientId: COGNITO_CLIENT_ID,
      region: AWS_REGION,
    }),
  );
}

import type { Handler } from 'aws-lambda';

export const handler: Handler = async (event) => {
  console.log('mailer invoked', JSON.stringify(event));
  return { statusCode: 200, body: 'ok' };
};

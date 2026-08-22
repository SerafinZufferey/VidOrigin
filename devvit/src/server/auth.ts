import { createHmac, randomUUID } from 'node:crypto';

export function signedHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  return {'content-type':'application/json','x-vidorigin-timestamp':timestamp,'x-vidorigin-nonce':nonce,'x-vidorigin-signature':signature};
}

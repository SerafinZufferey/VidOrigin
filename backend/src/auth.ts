import {createHmac,timingSafeEqual} from 'node:crypto';
const used=new Map<string,number>();
export function verifySignature(headers:Record<string,string|undefined>,body:Buffer,secret:string,now=Date.now()):boolean{
  const ts=headers['x-vidorigin-timestamp'],nonce=headers['x-vidorigin-nonce'],sig=headers['x-vidorigin-signature'];
  if(!ts||!nonce||!sig||!/^[0-9a-f]{64}$/i.test(sig)||!/^[0-9a-f-]{36}$/i.test(nonce)) return false;
  const seconds=Number(ts); if(!Number.isSafeInteger(seconds)||Math.abs(Math.floor(now/1000)-seconds)>300||used.has(nonce)) return false;
  const expected=createHmac('sha256',secret).update(`${ts}.${nonce}.${body.toString('utf8')}`).digest();
  const actual=Buffer.from(sig,'hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) return false;
  used.set(nonce,now+300_000); for(const [key,expiry] of used) if(expiry<now) used.delete(key); return true;
}

import {Hono} from 'hono';
import type {OnPostDeleteRequest,OnPostSubmitRequest,OnPostUpdateRequest,TriggerResponse} from '@devvit/web/shared';
import {reddit,redis,settings} from '@devvit/web/server';
import {buildComment,type SourceAnalysis} from './comment.js';
import {signedHeaders} from './auth.js';
import {randomUUID} from 'node:crypto';
import {detectPostMedia} from './media.js';

type BackendResult={searchId:string;analysis:SourceAnalysis;providers:{name:string;url:string}[]};
const app=new Hono();
const friendly=(error:unknown)=>error instanceof Error?error.message:'Unexpected processing error.';

async function backendConfig(){const backendUrl=(await settings.get<string>('backend-url'))?.replace(/\/$/,'');const secret=await settings.get<string>('backend-secret');if(!backendUrl||!secret)throw new Error('vidOrigin backend settings are missing.');return{backendUrl,secret};}

async function analyzePost(postId:string){
  const stateKey=`vidorigin:success:${postId}`;if(await redis.get(stateKey))return;
  const lockKey=`vidorigin:lock:${postId}`;const lockToken=randomUUID();
  await redis.set(lockKey,lockToken,{nx:true,expiration:new Date(Date.now()+120_000)});if(await redis.get(lockKey)!==lockToken)return;
  try{
    const post=await reddit.getPostById(postId as `t3_${string}`);let media;
    try{media=detectPostMedia(post);}catch{return;}
    const {backendUrl,secret}=await backendConfig();
    const body=JSON.stringify({postId:post.id,subreddit:post.subredditName,mediaType:media.type,mediaUrls:media.urls,...((media.type==='video'||media.type==='gif')&&media.declaredDuration?{declaredDuration:media.declaredDuration}:{})});
    const response=await fetch(`${backendUrl}/api/v1/analyses`,{method:'POST',headers:signedHeaders(secret,body),body,signal:AbortSignal.timeout(28_000)});
    const payload=await response.json().catch(()=>({})) as BackendResult&{error?:string};
    if(!response.ok)throw new Error(payload.error||`The media backend returned HTTP ${response.status}.`);
    if(!payload.providers?.length)throw new Error('No working manual search providers are available.');
    const comment=await reddit.submitComment({id:post.id,text:buildComment(post.subredditName,payload.providers,payload.analysis),runAs:'APP'});
    await redis.set(stateKey,JSON.stringify({commentId:comment.id,searchId:payload.searchId}));
  }finally{if(await redis.get(lockKey).catch(()=>undefined)===lockToken)await redis.del(lockKey).catch(()=>undefined);}
}

app.post('/internal/triggers/post-submit',async c=>{
  const event=await c.req.json<OnPostSubmitRequest>();const id=event.post?.id;
  if(id?.startsWith('t3_'))await analyzePost(id).catch(error=>console.error('Automatic source analysis failed',{postId:id,message:friendly(error)}));
  return c.json<TriggerResponse>({});
});

app.post('/internal/triggers/post-update',async c=>{
  const event=await c.req.json<OnPostUpdateRequest>();const id=event.post?.id;
  if(id?.startsWith('t3_'))await analyzePost(id).catch(error=>console.error('Updated-post source analysis failed',{postId:id,message:friendly(error)}));
  return c.json<TriggerResponse>({});
});

app.post('/internal/triggers/post-delete',async c=>{
  const event=await c.req.json<OnPostDeleteRequest>();const id=event.postId;
  if(id?.startsWith('t3_')){
    await redis.del(`vidorigin:success:${id}`).catch(()=>undefined);
    try{const {backendUrl,secret}=await backendConfig();const body='{}';await fetch(`${backendUrl}/api/v1/posts/${encodeURIComponent(id)}/delete`,{method:'POST',headers:signedHeaders(secret,body),body,signal:AbortSignal.timeout(10_000)});}catch(error){console.error('Source-search deletion failed',{postId:id,message:friendly(error)});}
  }
  return c.json<TriggerResponse>({});
});

export default app;

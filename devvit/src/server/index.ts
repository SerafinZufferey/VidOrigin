import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { context, reddit, redis, settings } from '@devvit/web/server';
import { buildComment } from './comment.js';
import { signedHeaders } from './auth.js';
import { randomUUID } from 'node:crypto';
import { detectPostMedia } from './media.js';

type BackendResult = {sessionId:string; expiresAt:string; providers:{name:string;url:string}[]};
const app = new Hono();
const friendly = (e: unknown) => e instanceof Error ? e.message : 'Unexpected processing error.';

app.post('/internal/menu/reverse-source', async (c) => {
  let lockKey: string | undefined;
  let lockToken: string | undefined;
  try {
    const input = await c.req.json<MenuItemRequest>();
    if (!input.targetId.startsWith('t3_')) throw new Error('Select a Reddit post and try again.');
    if (!context.userId || !context.username) throw new Error('You must be signed in as a moderator.');
    const moderators = await reddit.getModerators({subredditName:context.subredditName, username:context.username, limit:1}).all();
    if (!moderators.some(m => m.username.toLowerCase() === context.username!.toLowerCase())) throw new Error('Only moderators of this subreddit can run vidOrigin.');

    const stateKey = `vidorigin:success:${input.targetId}`;
    if (await redis.get(stateKey)) throw new Error('vidOrigin has already posted a reverse-search comment for this post.');
    lockKey = `vidorigin:lock:${input.targetId}`;
    lockToken = randomUUID();
    await redis.set(lockKey, lockToken, {nx:true, expiration:new Date(Date.now()+120_000)});
    if (await redis.get(lockKey) !== lockToken) throw new Error('This post is already being processed. Please wait a moment.');

    const post = await reddit.getPostById(input.targetId as `t3_${string}`);
    const media=detectPostMedia(post);

    const backendUrl = (await settings.get<string>('backend-url'))?.replace(/\/$/, '');
    const secret = await settings.get<string>('backend-secret');
    if (!backendUrl || !secret) throw new Error('vidOrigin is not configured. Ask the app developer to set the backend URL and secret.');
    const body = JSON.stringify({postId:post.id,subreddit:post.subredditName,mediaType:media.type,mediaUrls:media.urls,...(media.type==='video'&&media.declaredDuration?{declaredDuration:media.declaredDuration}:{})});
    const response = await fetch(`${backendUrl}/api/v1/sessions`, {method:'POST',headers:signedHeaders(secret,body),body,signal:AbortSignal.timeout(28_000)});
    const payload = await response.json().catch(() => ({})) as BackendResult & {error?:string};
    if (!response.ok) throw new Error(payload.error || `The media backend returned HTTP ${response.status}.`);
    if (!payload.providers?.length) throw new Error('No working reverse-search providers are available.');

    const comment = await reddit.submitComment({id:post.id,text:buildComment(post.subredditName,payload.providers),runAs:'APP'});
    await redis.set(stateKey, JSON.stringify({commentId:comment.id,sessionId:payload.sessionId,expiresAt:payload.expiresAt}));
    return c.json<UiResponse>({showToast:'vidOrigin posted the reverse source search comment.'});
  } catch (error) {
    console.error('Reverse source search failed', {message:friendly(error), postId:context.postId});
    return c.json<UiResponse>({showToast:`vidOrigin: ${friendly(error)}`});
  } finally {
    if (lockKey && lockToken && await redis.get(lockKey).catch(() => undefined) === lockToken) await redis.del(lockKey).catch(() => undefined);
  }
});

export default app;

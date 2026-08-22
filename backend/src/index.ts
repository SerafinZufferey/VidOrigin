import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import pino from 'pino';
import {pinoHttp} from 'pino-http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {config} from './config.js';
import {verifySignature} from './auth.js';
import {cleanup,createSessionDir,initializeStore,loadSession,root,saveSession} from './store.js';
import {downloadImage,downloadVideo,downloadExternalVideo,extractCandidates,prepareImage,probe,selectFrames,validateImageUrl,validateMediaUrl,isNativeRedditVideo} from './media.js';
import {providers,providerBySlug} from './providers.js';
import {expiredPage,landingPage} from './pages.js';

declare global{namespace Express{interface Request{rawBody?:Buffer}}}
const log=pino({level:config.LOG_LEVEL,redact:['req.headers.authorization','req.headers["x-vidorigin-signature"]','req.body.mediaUrls']});
const app=express();app.set('trust proxy',config.TRUST_PROXY);app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'none'"],imgSrc:["'self'"],styleSrc:["'unsafe-inline'"],baseUri:["'none'"],frameAncestors:["'none'"]}}}));app.use(pinoHttp({logger:log}));
app.use(express.json({limit:'8kb',verify:(req,_res,buf)=>{(req as express.Request).rawBody=Buffer.from(buf);}}));
app.use('/api/',rateLimit({windowMs:60_000,limit:config.RATE_LIMIT_PER_MINUTE,standardHeaders:'draft-8',legacyHeaders:false}));
let active=0;
const base={postId:z.string().regex(/^t3_[a-z0-9]+$/i),subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/)};
const inputSchema=z.discriminatedUnion('mediaType',[
  z.object({...base,mediaType:z.literal('video'),mediaUrls:z.tuple([z.string().url().max(2048)]),declaredDuration:z.number().positive().optional()}).strict(),
  z.object({...base,mediaType:z.literal('image'),mediaUrls:z.tuple([z.string().url().max(2048)])}).strict(),
  z.object({...base,mediaType:z.literal('gallery'),mediaUrls:z.array(z.string().url().max(2048)).min(1).max(config.MAX_GALLERY_IMAGES)}).strict()
]);

app.get('/healthz',(_req,res)=>res.json({ok:true,activeJobs:active}));
app.post('/api/v1/sessions',async(req,res)=>{
  if(!verifySignature(req.headers as Record<string,string|undefined>,req.rawBody||Buffer.alloc(0),config.DEVVIT_SHARED_SECRET))return res.status(401).json({error:'Backend authentication failed.'});
  const parsed=inputSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'The processing request was invalid.'});
  if(active>=config.MAX_CONCURRENT_JOBS)return res.status(503).json({error:'The media processor is busy. Please try again shortly.'});
  if(parsed.data.mediaType==='video'&&parsed.data.declaredDuration&&parsed.data.declaredDuration>config.MAX_VIDEO_DURATION_SECONDS)return res.status(413).json({error:'This video is too long to process.'});
  active++;let dir:string|undefined;
  try{
    const created=await createSessionDir();dir=created.dir;let assets:string[];let duration:number|undefined;
    if(parsed.data.mediaType==='video'){
  const rawVideoUrl=parsed.data.mediaUrls[0];
  const video=path.join(dir,'source.mp4');

  if(isNativeRedditVideo(rawVideoUrl)){
    const media=await validateMediaUrl(rawVideoUrl);
    await downloadVideo(media,video);
  }else{
    await downloadExternalVideo(rawVideoUrl,video);
  }

  duration=await probe(video);
  const candidates=await extractCandidates(video,dir,duration);
  await fs.unlink(video).catch(()=>undefined);
  assets=await selectFrames(candidates,dir,10);    }else{
      let totalBytes=0;assets=[];
      for(const [index,raw] of parsed.data.mediaUrls.entries()){
        const media=await validateImageUrl(raw);const source=path.join(dir,`source-${index}.image`);totalBytes+=await downloadImage(media,source);if(totalBytes>config.MAX_VIDEO_BYTES)throw new Error('The gallery is too large to process.');assets.push(await prepareImage(source,dir));
      }
    }
    const now=new Date(),expires=new Date(now.getTime()+config.SESSION_TTL_MINUTES*60_000);const session={id:created.id,createdAt:now.toISOString(),expiresAt:expires.toISOString(),postId:parsed.data.postId,subreddit:parsed.data.subreddit,mediaType:parsed.data.mediaType,assets:assets.map(f=>path.basename(f))};await saveSession(dir,session);log.info({postId:parsed.data.postId,mediaType:parsed.data.mediaType,assetCount:assets.length,duration},'source search session created');return res.status(201).json({sessionId:session.id,expiresAt:session.expiresAt,providers:providers.map(p=>({name:p.name,url:`${config.publicBaseUrl}/s/${session.id}/${p.slug}`}))});
  }catch(error){if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(()=>undefined);const message=error instanceof Error?error.message:'Media processing failed.';log.warn({err:error instanceof Error?{name:error.name,message:error.message}:error,postId:parsed.data.postId,mediaType:parsed.data.mediaType},'source search session failed');const status=/too (large|long)/i.test(message)?413:/unsupported|unsafe|content type/i.test(message)?400:422;return res.status(status).json({error:message.replace(/FFmpeg failed.*$/s,'The video could not be decoded.')});}finally{active--;}
});
app.get('/s/:id/:provider',async(req,res)=>{const session=await loadSession(req.params.id);if(!session)return res.status(410).type('html').send(expiredPage());if(!providerBySlug(req.params.provider))return res.status(404).send('Unknown search provider.');return res.type('html').send(landingPage(session,req.params.provider));});
app.get('/s/:id/assets/:file',async(req,res)=>{const session=await loadSession(req.params.id);if(!session||!session.assets.includes(req.params.file))return res.status(410).type('html').send(expiredPage());return res.set({'cache-control':'private, max-age=300','content-type':'image/jpeg','x-content-type-options':'nosniff'}).sendFile(path.join(root,session.id,req.params.file));});
app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
await initializeStore();setInterval(()=>cleanup().catch(err=>log.error({err},'cleanup failed')),60_000).unref();
const server=app.listen(config.PORT,()=>log.info({port:config.PORT},'vidOrigin backend listening'));
const shutdown=()=>server.close(()=>process.exit(0));process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

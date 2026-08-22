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
import {cleanup,createSessionDir,deleteRecipesForPost,initializeStore,loadRecipe,loadSession,root,saveRecipe,saveSession,type Recipe,type Session} from './store.js';
import {downloadImage,downloadVideo,downloadExternalVideo,extractCandidates,prepareImage,probe,selectFrames,validateGifUrl,validateImageUrl,validateMediaUrl,isNativeRedditVideo} from './media.js';
import {providers,providerBySlug} from './providers.js';
import {expiredPage,landingPage} from './pages.js';
import {analyzeSources} from './vision.js';

declare global{namespace Express{interface Request{rawBody?:Buffer}}}
const log=pino({level:config.LOG_LEVEL,redact:['req.headers.authorization','req.headers["x-vidorigin-signature"]','req.body.mediaUrls','req.query.key']});
const app=express();app.set('trust proxy',config.TRUST_PROXY);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'none'"],imgSrc:["'self'"],styleSrc:["'unsafe-inline'"],baseUri:["'none'"],frameAncestors:["'none'"]}}}));
app.use(pinoHttp({logger:log}));
app.use(express.json({limit:'8kb',verify:(req,_res,buf)=>{(req as express.Request).rawBody=Buffer.from(buf);}}));
app.use('/api/',rateLimit({windowMs:60_000,limit:config.RATE_LIMIT_PER_MINUTE,standardHeaders:'draft-8',legacyHeaders:false}));
app.use('/s/',rateLimit({windowMs:60_000,limit:10,standardHeaders:'draft-8',legacyHeaders:false}));

let active=0;
const rebuilds=new Map<string,Promise<Session>>();
const base={postId:z.string().regex(/^t3_[a-z0-9]+$/i),subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/)};
const inputSchema=z.discriminatedUnion('mediaType',[
  z.object({...base,mediaType:z.literal('video'),mediaUrls:z.tuple([z.string().url().max(2048)]),declaredDuration:z.number().positive().optional()}).strict(),
  z.object({...base,mediaType:z.literal('gif'),mediaUrls:z.tuple([z.string().url().max(2048)]),declaredDuration:z.number().positive().optional()}).strict(),
  z.object({...base,mediaType:z.literal('image'),mediaUrls:z.tuple([z.string().url().max(2048)])}).strict(),
  z.object({...base,mediaType:z.literal('gallery'),mediaUrls:z.array(z.string().url().max(2048)).min(1).max(config.MAX_GALLERY_IMAGES)}).strict()
]);
type Input=z.infer<typeof inputSchema>;
const authenticate=(req:express.Request)=>verifySignature(req.headers as Record<string,string|undefined>,req.rawBody||Buffer.alloc(0),config.DEVVIT_SHARED_SECRET);

async function processMedia(input:Input,id?:string):Promise<{session:Session;dir:string;files:string[]}>{
  if(active>=config.MAX_CONCURRENT_JOBS)throw new Error('The media processor is busy. Please try again shortly.');
  if((input.mediaType==='video'||input.mediaType==='gif')&&input.declaredDuration&&input.declaredDuration>config.MAX_VIDEO_DURATION_SECONDS)throw new Error('This video is too long to process.');
  active++;let dir:string|undefined;
  try{
    const created=await createSessionDir(id);dir=created.dir;let assets:string[]=[];let duration:number|undefined;
    if(input.mediaType==='video'||input.mediaType==='gif'){
      const raw=input.mediaUrls[0];const source=path.join(dir,input.mediaType==='gif'?'source.gif':'source.mp4');
      if(isNativeRedditVideo(raw))await downloadVideo(await validateMediaUrl(raw),source);
      else if(input.mediaType==='gif')await downloadImage(await validateGifUrl(raw),source,validateGifUrl,true);
      else await downloadExternalVideo(raw,source);
      duration=await probe(source);const candidates=await extractCandidates(source,dir,duration);await fs.unlink(source).catch(()=>undefined);assets=await selectFrames(candidates,dir,10);
    }else{
      let totalBytes=0;
      for(const [index,raw] of input.mediaUrls.entries()){
        const source=path.join(dir,`source-${index}.image`);totalBytes+=await downloadImage(await validateImageUrl(raw),source);
        if(totalBytes>config.MAX_VIDEO_BYTES)throw new Error('The gallery is too large to process.');assets.push(await prepareImage(source,dir));
      }
    }
    const now=new Date();const session:Session={id:created.id,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+config.SESSION_TTL_MINUTES*60_000).toISOString(),postId:input.postId,subreddit:input.subreddit,mediaType:input.mediaType,assets:assets.map(file=>path.basename(file))};
    await saveSession(dir,session);log.info({postId:input.postId,mediaType:input.mediaType,assetCount:assets.length,duration},'source search media processed');return{session,dir,files:assets};
  }catch(error){if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(()=>undefined);throw error;}finally{active--;}
}

const recipeInput=(recipe:Recipe):Input=>({postId:recipe.postId,subreddit:recipe.subreddit,mediaType:recipe.mediaType,mediaUrls:recipe.mediaUrls,...(recipe.declaredDuration?{declaredDuration:recipe.declaredDuration}:{})} as Input);
async function ensureManualSession(recipe:Recipe){const existing=await loadSession(recipe.id);if(existing)return existing;const running=rebuilds.get(recipe.id);if(running)return running;const job=processMedia(recipeInput(recipe),recipe.id).then(result=>result.session).finally(()=>rebuilds.delete(recipe.id));rebuilds.set(recipe.id,job);return job;}

app.get('/healthz',(_req,res)=>res.json({ok:true,activeJobs:active}));
app.post('/api/v1/analyses',async(req,res)=>{
  if(!authenticate(req))return res.status(401).json({error:'Backend authentication failed.'});
  const parsed=inputSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'The processing request was invalid.'});let dir:string|undefined;
  try{const processed=await processMedia(parsed.data);dir=processed.dir;const analysis=await analyzeSources(processed.files);const recipe=await saveRecipe({...parsed.data,mediaUrls:[...parsed.data.mediaUrls],analysis});await fs.rm(processed.dir,{recursive:true,force:true});dir=undefined;return res.status(201).json({searchId:recipe.id,analysis,providers:providers.map(p=>({name:p.name,url:`${config.publicBaseUrl}/s/${recipe.id}/${p.slug}`}))});}
  catch(error){if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(()=>undefined);const message=error instanceof Error?error.message:'Media analysis failed.';log.warn({err:{message},postId:parsed.data.postId},'automatic source analysis failed');return res.status(/too (large|long)/i.test(message)?413:422).json({error:message});}
});
app.post('/api/v1/posts/:postId/delete',async(req,res)=>{if(!authenticate(req))return res.status(401).json({error:'Backend authentication failed.'});if(!/^t3_[a-z0-9]+$/i.test(req.params.postId))return res.status(400).json({error:'Invalid post ID.'});await deleteRecipesForPost(req.params.postId);return res.status(204).send();});
app.get('/s/:id/:provider',async(req,res)=>{const provider=providerBySlug(req.params.provider);if(!provider)return res.status(404).send('Unknown search provider.');const recipe=await loadRecipe(req.params.id);if(!recipe)return res.status(410).type('html').send(expiredPage('This source-search link is no longer available.'));try{const session=await ensureManualSession(recipe);return res.type('html').send(landingPage(session,provider.slug,recipe.analysis));}catch(error){log.warn({err:{message:error instanceof Error?error.message:'rebuild failed'},postId:recipe.postId},'manual session rebuild failed');return res.status(503).type('html').send(expiredPage('The media could not be prepared right now. Please wait a moment and open this link again.'));}});
app.get('/s/:id/assets/:file',async(req,res)=>{const session=await loadSession(req.params.id);if(!session||!session.assets.includes(req.params.file))return res.status(410).type('html').send(expiredPage('This temporary media expired. Reopen the provider link to create a fresh manual session.'));return res.set({'cache-control':'private, max-age=300','content-type':'image/jpeg','x-content-type-options':'nosniff'}).sendFile(path.join(root,session.id,req.params.file));});
app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
await initializeStore();setInterval(()=>cleanup().catch(err=>log.error({err},'cleanup failed')),60_000).unref();
const server=app.listen(config.PORT,()=>log.info({port:config.PORT},'vidOrigin backend listening'));
const shutdown=()=>server.close(()=>process.exit(0));process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

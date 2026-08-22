import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {config} from './config.js';
import type {SourceAnalysis} from './vision.js';
export type MediaType='video'|'gif'|'image'|'gallery';
export type Session={id:string;createdAt:string;expiresAt:string;postId:string;subreddit:string;mediaType:MediaType;assets:string[]};
export type Recipe={id:string;createdAt:string;postId:string;subreddit:string;mediaType:MediaType;mediaUrls:string[];declaredDuration?:number;analysis:SourceAnalysis};
export const root=path.resolve(config.DATA_DIR);
const recipesRoot=path.join(root,'recipes');
export async function initializeStore(){await fs.mkdir(root,{recursive:true,mode:0o700});await fs.mkdir(recipesRoot,{recursive:true,mode:0o700});await cleanup();}
export async function createSessionDir(id=randomBytes(32).toString('base64url')){const dir=path.join(root,id);await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{mode:0o700});return{id,dir};}
export async function saveSession(dir:string,session:Session){await fs.writeFile(path.join(dir,'session.json'),JSON.stringify(session),{encoding:'utf8',mode:0o600,flag:'wx'});}
export async function loadSession(id:string):Promise<Session|undefined>{if(!/^[A-Za-z0-9_-]{43}$/.test(id))return;try{const raw=await fs.readFile(path.join(root,id,'session.json'),'utf8');const session=JSON.parse(raw) as Session;if(new Date(session.expiresAt).getTime()<=Date.now())return;return session;}catch{return;}}
export async function saveRecipe(input:Omit<Recipe,'id'|'createdAt'>){const recipe:Recipe={...input,id:randomBytes(32).toString('base64url'),createdAt:new Date().toISOString()};await fs.writeFile(path.join(recipesRoot,`${recipe.id}.json`),JSON.stringify(recipe),{encoding:'utf8',mode:0o600,flag:'wx'});return recipe;}
export async function loadRecipe(id:string):Promise<Recipe|undefined>{if(!/^[A-Za-z0-9_-]{43}$/.test(id))return;try{return JSON.parse(await fs.readFile(path.join(recipesRoot,`${id}.json`),'utf8')) as Recipe;}catch{return;}}
export async function deleteRecipesForPost(postId:string){for(const file of await fs.readdir(recipesRoot).catch(()=>[])){try{const full=path.join(recipesRoot,file);const recipe=JSON.parse(await fs.readFile(full,'utf8')) as Recipe;if(recipe.postId===postId){await fs.rm(path.join(root,recipe.id),{recursive:true,force:true});await fs.unlink(full);}}catch{}}}
export async function cleanup(){let entries:string[]=[];try{entries=await fs.readdir(root);}catch{return;}await Promise.all(entries.filter(id=>id!=='recipes').map(async id=>{const dir=path.join(root,id);try{const stat=await fs.stat(dir);let expired=stat.mtimeMs+config.SESSION_TTL_MINUTES*60_000<Date.now();try{const s=JSON.parse(await fs.readFile(path.join(dir,'session.json'),'utf8')) as Session;expired=new Date(s.expiresAt).getTime()<=Date.now();}catch{}if(expired)await fs.rm(dir,{recursive:true,force:true});}catch{}}));}

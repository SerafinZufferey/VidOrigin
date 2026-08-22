import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {config} from './config.js';
export type Session={id:string;createdAt:string;expiresAt:string;postId:string;subreddit:string;mediaType:'video'|'image'|'gallery';assets:string[]};
export const root=path.resolve(config.DATA_DIR);
export async function initializeStore(){await fs.mkdir(root,{recursive:true,mode:0o700});await cleanup();}
export async function createSessionDir(){const id=randomBytes(32).toString('base64url');const dir=path.join(root,id);await fs.mkdir(dir,{mode:0o700});return{id,dir};}
export async function saveSession(dir:string,session:Session){await fs.writeFile(path.join(dir,'session.json'),JSON.stringify(session),{encoding:'utf8',mode:0o600,flag:'wx'});}
export async function loadSession(id:string):Promise<Session|undefined>{if(!/^[A-Za-z0-9_-]{43}$/.test(id))return;try{const raw=await fs.readFile(path.join(root,id,'session.json'),'utf8');const session=JSON.parse(raw) as Session;if(new Date(session.expiresAt).getTime()<=Date.now())return;return session;}catch{return;}}
export async function cleanup(){let entries:string[]=[];try{entries=await fs.readdir(root);}catch{return;}await Promise.all(entries.map(async id=>{const dir=path.join(root,id);try{const stat=await fs.stat(dir);let expired=stat.mtimeMs+config.SESSION_TTL_MINUTES*60_000<Date.now();try{const s=JSON.parse(await fs.readFile(path.join(dir,'session.json'),'utf8')) as Session;expired=new Date(s.expiresAt).getTime()<=Date.now();}catch{}if(expired)await fs.rm(dir,{recursive:true,force:true});}catch{}}));}

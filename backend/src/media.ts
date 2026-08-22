import {promises as fs,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {lookup} from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import {config} from './config.js';

const VIDEO_HOSTS=new Set([
  'v.redd.it',
  'packaged-media.redd.it'
]);

const IMAGE_HOSTS=new Set([
  'i.redd.it',
  'preview.redd.it',
  'encrypted-tbn0.gstatic.com'
]);
const GIF_HOSTS=new Set([...IMAGE_HOSTS,...config.EXTERNAL_GIF_HOSTS.split(',').map(host=>host.trim().toLowerCase()).filter(Boolean)]);

const isPrivate=(ip:string)=>
  ip==='::1' ||
  ip.startsWith('10.') ||
  ip.startsWith('127.') ||
  ip.startsWith('192.168.') ||
  ip.startsWith('169.254.') ||
  ip.startsWith('fc') ||
  ip.startsWith('fd') ||
  (/^172\.(1[6-9]|2\d|3[01])\./).test(ip);

async function validateUrl(
  raw:string,
  hosts:Set<string>,
  kind:string
):Promise<URL>{
  const u=new URL(raw);

  if(
    u.protocol!=='https:' ||
    u.username ||
    u.password ||
    u.port ||
    !hosts.has(u.hostname.toLowerCase())
  ){
    throw new Error(`Unsupported ${kind} host.`);
  }

  const addresses=await lookup(u.hostname,{all:true});

  if(
    !addresses.length ||
    addresses.some(a=>isPrivate(a.address))
  ){
    throw new Error(`The ${kind} host resolved to an unsafe address.`);
  }

  return u;
}

export const validateMediaUrl=(raw:string)=>
  validateUrl(raw,VIDEO_HOSTS,'video');

export const validateImageUrl=(raw:string)=>
  validateUrl(raw,IMAGE_HOSTS,'image');

export const isNativeRedditVideo=(raw:string)=>{
  try{
    const u=new URL(raw);

    return (
      u.protocol==='https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      VIDEO_HOSTS.has(u.hostname.toLowerCase())
    );
  }catch{
    return false;
  }
};

async function validateExternalVideoPage(raw:string):Promise<URL>{
  const u=new URL(raw);

  if(
    u.protocol!=='https:' ||
    u.username ||
    u.password ||
    u.port
  ){
    throw new Error('Unsupported external video URL.');
  }

  const addresses=await lookup(u.hostname,{all:true});

  if(
    !addresses.length ||
    addresses.some(a=>isPrivate(a.address))
  ){
    throw new Error('The external video host resolved to an unsafe address.');
  }

  return u;
}

export const validateGifUrl=(raw:string)=>validateUrl(raw,GIF_HOSTS,'GIF');

export async function downloadExternalVideo(
  raw:string,
  destination:string
):Promise<void>{
  const url=await validateExternalVideoPage(raw);

  await new Promise<void>((resolve,reject)=>{
    const child=spawn(
      'yt-dlp',
      [
        '--no-playlist',
        '--no-warnings',
        '--max-filesize',
        `${config.MAX_VIDEO_BYTES}`,
        '--match-filter',
        `duration <= ${config.MAX_VIDEO_DURATION_SECONDS}`,
        '--merge-output-format',
        'mp4',
        '--output',
        destination,
        url.toString()
      ],
      {
        windowsHide:true,
        stdio:['ignore','pipe','pipe']
      }
    );

    let err='';

    const timer=setTimeout(()=>{
      child.kill('SIGKILL');
      reject(new Error('External video download timed out.'));
    },60_000);

    child.stderr.on('data',d=>err+=d);

    child.on('error',error=>{
      clearTimeout(timer);
      reject(error);
    });

    child.on('close',code=>{
      clearTimeout(timer);

      if(code===0){
        fs.stat(destination)
          .then(stat=>{
            if(!stat.isFile()||stat.size===0){
              reject(new Error('External video download completed without producing a usable video file.'));
            }else{
              resolve();
            }
          })
          .catch(()=>reject(new Error('External video download completed without producing a usable video file.')));
      }else{
        reject(
          new Error(
            `External video download failed: ${err.slice(-500)}`
          )
        );
      }
    });
  });
}

export async function downloadVideo(
  url:URL,
  destination:string
):Promise<void>{
  let current=url;

  for(let redirects=0;redirects<=2;redirects++){
    const response=await fetch(current,{
      redirect:'manual',
      headers:{
        'user-agent':'vidOrigin/1.0'
      },
      signal:AbortSignal.timeout(15_000)
    });

    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');

      if(!location){
        throw new Error(
          'The video host returned an invalid redirect.'
        );
      }

      current=await validateMediaUrl(
        new URL(location,current).toString()
      );

      continue;
    }

    if(!response.ok||!response.body){
      throw new Error(
        `Reddit video download failed (HTTP ${response.status}).`
      );
    }

    const type=(
      response.headers.get('content-type')||''
    ).toLowerCase();

    if(
      !type.includes('video/') &&
      !type.includes('application/octet-stream')
    ){
      throw new Error(
        'Reddit returned an unexpected content type.'
      );
    }

    const length=Number(
      response.headers.get('content-length')||0
    );

    if(length>config.MAX_VIDEO_BYTES){
      throw new Error(
        'This video is too large to process.'
      );
    }

    let bytes=0;

    const limiter=new Transform({
      transform(chunk,_e,cb){
        bytes+=chunk.length;

        cb(
          bytes>config.MAX_VIDEO_BYTES
            ? new Error(
                'This video is too large to process.'
              )
            : null,
          chunk
        );
      }
    });

    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      createWriteStream(destination,{flags:'wx'})
    );

    if(bytes===0){
      throw new Error('Reddit returned an empty video file.');
    }

    return;
  }

  throw new Error(
    'The video host redirected too many times.'
  );
}

export async function downloadImage(
  url:URL,
  destination:string,
  validateRedirect:(raw:string)=>Promise<URL>=validateImageUrl,
  gifOnly=false
):Promise<number>{
  let current=url;

  for(let redirects=0;redirects<=2;redirects++){
    const response=await fetch(current,{
      redirect:'manual',
      headers:{
        'user-agent':'vidOrigin/1.0'
      },
      signal:AbortSignal.timeout(15_000)
    });

    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');

      if(!location){
        throw new Error(
          'The image host returned an invalid redirect.'
        );
      }

      current=await validateRedirect(
        new URL(location,current).toString()
      );

      continue;
    }

    if(!response.ok||!response.body){
      throw new Error(
        `Image download failed (HTTP ${response.status}).`
      );
    }

    const type=(
      response.headers.get('content-type')||''
    )
      .split(';')[0]!
      .trim()
      .toLowerCase();

    if(gifOnly?type!=='image/gif':![
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif'
      ].includes(type)){
      throw new Error(
        'The image host returned an unexpected image content type.'
      );
    }

    const length=Number(
      response.headers.get('content-length')||0
    );

    if(length>config.MAX_IMAGE_BYTES){
      throw new Error(
        'The image is too large to process.'
      );
    }

    let bytes=0;

    const limiter=new Transform({
      transform(chunk,_e,cb){
        bytes+=chunk.length;

        cb(
          bytes>config.MAX_IMAGE_BYTES
            ? new Error(
                'The image is too large to process.'
              )
            : null,
          chunk
        );
      }
    });

    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      createWriteStream(destination,{flags:'wx'})
    );

    return bytes;
  }

  throw new Error(
    'The image host redirected too many times.'
  );
}

export async function prepareImage(
  source:string,
  dir:string,
  removeSource=true
):Promise<string>{
  const output=path.join(
    dir,
    `${randomBytes(16).toString('hex')}.jpg`
  );

  const image=sharp(source,{
    limitInputPixels:config.MAX_IMAGE_PIXELS,
    animated:false
  });

  const metadata=await image.metadata();

  if(!metadata.width||!metadata.height){
    throw new Error(
      'The image could not be decoded.'
    );
  }

  await image
    .rotate()
    .jpeg({
      quality:94,
      mozjpeg:true
    })
    .toFile(output);

  if(removeSource){
    await fs.unlink(source).catch(()=>undefined);
  }

  return output;
}

function run(
  command:string,
  args:string[],
  timeout=20_000
):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(
      command,
      args,
      {
        windowsHide:true,
        stdio:['ignore','pipe','pipe']
      }
    );

    let out='';
    let err='';

    const timer=setTimeout(()=>{
      child.kill('SIGKILL');
      reject(
        new Error('Video processing timed out.')
      );
    },timeout);

    child.stdout.on('data',d=>out+=d);
    child.stderr.on('data',d=>err+=d);

    child.on('error',reject);

    child.on('close',code=>{
      clearTimeout(timer);

      if(code===0){
        resolve(out);
      }else{
        reject(
          new Error(
            `FFmpeg failed (${code}): ${err.slice(-500)}`
          )
        );
      }
    });
  });
}

export async function probe(
  file:string
):Promise<number>{
  const raw=await run(
    config.FFPROBE_PATH,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      file
    ],
    8_000
  );

  const duration=Number(
    JSON.parse(raw).format?.duration
  );

  if(!Number.isFinite(duration)||duration<=0){
    throw new Error(
      'Could not determine video duration.'
    );
  }

  if(duration>config.MAX_VIDEO_DURATION_SECONDS){
    throw new Error(
      'This video is too long to process.'
    );
  }

  return duration;
}

export async function extractCandidates(
  video:string,
  dir:string,
  duration:number
):Promise<string[]>{
  const pattern=path.join(
    dir,
    'candidate-%02d.jpg'
  );

  const fps=Math.min(
    10,
    Math.max(0.1,24/duration)
  );

  await run(
    config.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      video,
      '-vf',
      `fps=${fps},scale='min(960,iw)':-2:flags=lanczos`,
      '-frames:v',
      '24',
      '-q:v',
      '3',
      pattern
    ],
    22_000
  );

  return (
    await fs.readdir(dir)
  )
    .filter(n=>n.startsWith('candidate-'))
    .sort()
    .map(n=>path.join(dir,n));
}

type Candidate={
  file:string;
  score:number;
  hash:bigint;
};

async function assess(
  file:string
):Promise<Candidate>{
  const image=sharp(file);
  const stats=await image.stats();

  const {data}=await image
    .clone()
    .greyscale()
    .resize(9,8,{fit:'fill'})
    .raw()
    .toBuffer({
      resolveWithObject:true
    });

  let hash=0n;

  for(let y=0;y<8;y++){
    for(let x=0;x<8;x++){
      hash<<=1n;

      if(
        data[y*9+x]!>
        data[y*9+x+1]!
      ){
        hash|=1n;
      }
    }
  }

  const brightness=
    stats.channels
      .slice(0,3)
      .reduce((s,c)=>s+c.mean,0)/3;

  const contrast=
    stats.channels
      .slice(0,3)
      .reduce((s,c)=>s+c.stdev,0)/3;

  const blackPenalty=
    brightness<18
      ? 1000
      : 0;

  return{
    file,
    hash,
    score:contrast-blackPenalty
  };
}

const distance=(
  a:bigint,
  b:bigint
)=>{
  let n=a^b;
  let c=0;

  while(n){
    c+=Number(n&1n);
    n>>=1n;
  }

  return c;
};

export async function selectFrames(
  files:string[],
  dir:string,
  count=10
):Promise<string[]>{
  const candidates=(
    await Promise.all(
      files.map(assess)
    )
  ).sort(
    (a,b)=>b.score-a.score
  );

  const chosen:Candidate[]=[];

  for(const c of candidates){
    if(
      chosen.every(
        x=>distance(x.hash,c.hash)>=10
      )
    ){
      chosen.push(c);
    }

    if(chosen.length===count){
      break;
    }
  }

  for(const c of candidates){
    if(
      chosen.length<count &&
      !chosen.includes(c)
    ){
      chosen.push(c);
    }
  }

  if(chosen.length<5){
    throw new Error(
      'Not enough distinct usable frames could be extracted.'
    );
  }

  const outputs:string[]=[];

  for(const c of chosen){
    const output=path.join(
      dir,
      `${randomBytes(16).toString('hex')}.jpg`
    );

    await sharp(c.file)
      .jpeg({
        quality:86,
        mozjpeg:true
      })
      .toFile(output);

    outputs.push(output);
  }

  await Promise.all(
    files.map(
      f=>fs.unlink(f).catch(()=>undefined)
    )
  );

  return outputs;
}

import {promises as fs} from 'node:fs';
import {config} from './config.js';

export type SourceMatch={url:string;title:string;frameCount:number;kind:'full'|'partial'};
export type SourceAnalysis={summary:string;description:string;matches:SourceMatch[];labels:string[]};

type WebPage={url?:string;pageTitle?:string;fullMatchingImages?:unknown[];partialMatchingImages?:unknown[]};
type WebDetection={pagesWithMatchingImages?:WebPage[];bestGuessLabels?:{label?:string}[]};
type Annotation={description?:string;score?:number};
type VisionResponse={responses?:{webDetection?:WebDetection;labelAnnotations?:Annotation[];landmarkAnnotations?:Annotation[];error?:{message?:string}}[];error?:{message?:string}};

const safeWebUrl=(raw:string|undefined)=>{
  if(!raw)return;
  try{const url=new URL(raw);if(url.protocol==='https:'||url.protocol==='http:')return url.toString();}catch{}
};

export async function analyzeSources(files:string[]):Promise<SourceAnalysis>{
  if(!config.GOOGLE_CLOUD_VISION_API_KEY)throw new Error('Google Cloud Vision is not configured.');
  const requests=await Promise.all(files.map(async file=>({
    image:{content:(await fs.readFile(file)).toString('base64')},
    features:[{type:'WEB_DETECTION',maxResults:10},{type:'LABEL_DETECTION',maxResults:10},{type:'LANDMARK_DETECTION',maxResults:3}]
  })));
  const response=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(config.GOOGLE_CLOUD_VISION_API_KEY)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests}),signal:AbortSignal.timeout(20_000)
  });
  const payload=await response.json().catch(()=>({})) as VisionResponse;
  if(!response.ok)throw new Error(`Google Cloud Vision failed (HTTP ${response.status}).`);
  if(payload.error?.message)throw new Error('Google Cloud Vision rejected the analysis request.');
  const matches=new Map<string,SourceMatch>();
  const labels=new Map<string,{label:string;score:number;count:number}>();
  const landmarks=new Map<string,{label:string;score:number;count:number}>();
  const addAnnotation=(target:Map<string,{label:string;score:number;count:number}>,label:string|undefined,score=0)=>{
    const clean=label?.replace(/\s+/g,' ').trim().slice(0,100);if(!clean)return;
    const key=clean.toLocaleLowerCase('en');const current=target.get(key);
    if(current){current.count++;current.score=Math.max(current.score,score);}
    else target.set(key,{label:clean,score,count:1});
  };
  for(const item of payload.responses??[]){
    if(item.error?.message)continue;
    for(const label of item.webDetection?.bestGuessLabels??[])addAnnotation(labels,label.label,0.9);
    for(const label of item.labelAnnotations??[])if((label.score??0)>=0.7)addAnnotation(labels,label.description,label.score);
    for(const landmark of item.landmarkAnnotations??[])if((landmark.score??0)>=0.5)addAnnotation(landmarks,landmark.description,landmark.score);
    const seen=new Set<string>();
    for(const page of item.webDetection?.pagesWithMatchingImages??[]){
      const url=safeWebUrl(page.url);if(!url||seen.has(url))continue;seen.add(url);
      const kind=page.fullMatchingImages?.length?'full':page.partialMatchingImages?.length?'partial':undefined;
      if(!kind)continue;
      const current=matches.get(url);
      if(current){current.frameCount++;if(kind==='full')current.kind='full';}
      else matches.set(url,{url,title:(page.pageTitle??new URL(url).hostname).replace(/<[^>]*>/g,'').slice(0,160),frameCount:1,kind});
    }
  }
  const ranked=[...matches.values()]
    .filter(match=>match.kind==='full'||match.frameCount>=2)
    .sort((a,b)=>Number(b.kind==='full')-Number(a.kind==='full')||b.frameCount-a.frameCount)
    .slice(0,5);
  const summary=ranked.length
    ? `${ranked.length} stronger possible source ${ranked.length===1?'lead was':'leads were'} found. The strongest lead is ${ranked[0]!.kind==='full'?'an exact-image match':`supported by ${ranked[0]!.frameCount} separate frames`}. Manual review is still required; this does not establish original authorship.`
    : `No sufficiently strong source match was found. Weak visual similarities were omitted because they can be unrelated. This does not prove that the media is original or previously unpublished.`;
  const rankedLandmarks=[...landmarks.values()].sort((a,b)=>b.count-a.count||b.score-a.score).map(item=>item.label).slice(0,2);
  const rankedLabels=[...labels.values()].sort((a,b)=>b.count-a.count||b.score-a.score).map(item=>item.label).filter(label=>!rankedLandmarks.some(landmark=>landmark.toLocaleLowerCase('en')===label.toLocaleLowerCase('en'))).slice(0,8);
  const labelText=rankedLabels.slice(0,6).join(', ');
  const description=rankedLandmarks.length
    ? `The media may show ${rankedLandmarks.join(' and ')}${labelText?`, with visual elements including ${labelText}`:''}. This description is machine-generated and may be incomplete or incorrect.`
    : labelText
      ? `The media appears to contain visual elements including ${labelText}. This description is machine-generated and may be incomplete or incorrect.`
      : `No reliable visual description could be generated for this media.`;
  return{summary,description,matches:ranked,labels:rankedLabels};
}

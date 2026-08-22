import {promises as fs} from 'node:fs';
import {config} from './config.js';

export type SourceMatch={url:string;title:string;frameCount:number;kind:'full'|'partial'};
export type SourceAnalysis={summary:string;description:string;context?:string;matches:SourceMatch[];labels:string[]};

type WebPage={url?:string;pageTitle?:string;fullMatchingImages?:unknown[];partialMatchingImages?:unknown[]};
type WebDetection={pagesWithMatchingImages?:WebPage[];bestGuessLabels?:{label?:string}[];webEntities?:Annotation[]};
type Annotation={description?:string;score?:number};
type VisionResponse={responses?:{webDetection?:WebDetection;labelAnnotations?:Annotation[];landmarkAnnotations?:Annotation[];error?:{message?:string}}[];error?:{message?:string}};

const safeWebUrl=(raw:string|undefined)=>{
  if(!raw)return;
  try{const url=new URL(raw);if(url.protocol==='https:'||url.protocol==='http:')return url.toString();}catch{}
};

const humanList=(items:string[])=>items.length<2?items[0]??'':items.length===2?`${items[0]} and ${items[1]}`:`${items.slice(0,-1).join(', ')}, and ${items.at(-1)}`;
const genericArtLabels=new Set(['anime','animation','animated cartoon','cartoon','fictional character','cg artwork','digital art','illustration','art','visual arts','graphics']);
const genericPersonLabels=new Set(['person','girl','woman','man','female','male','beauty','face','head','neck','lips','skin']);
const naturalDescription=(labels:string[],landmarks:string[])=>{
  const lower=new Set(labels.map(label=>label.toLocaleLowerCase('en')));
  const artwork=[...lower].some(label=>genericArtLabels.has(label));
  const person=[...lower].some(label=>genericPersonLabels.has(label));
  const hair=labels.find(label=>/^(black|brown|blond|blonde|red|white|long|short) hair$/i.test(label));
  const details=labels.filter(label=>!genericArtLabels.has(label.toLocaleLowerCase('en'))&&!genericPersonLabels.has(label.toLocaleLowerCase('en'))&&label!==hair).slice(0,4).map(label=>label.toLocaleLowerCase('en'));
  let sentence='';
  if(landmarks.length)sentence=`The media may show ${humanList(landmarks)}.`;
  else if(artwork)sentence=`The media appears to show ${person?'a stylized character':'a digitally illustrated scene'}${hair?` with ${hair.toLocaleLowerCase('en')}`:''}.`;
  else if(person)sentence=`The media appears to show a person${hair?` with ${hair.toLocaleLowerCase('en')}`:''}.`;
  else if(details.length)sentence=`The media appears to show ${humanList(details)}.`;
  else return 'No reliable visual description could be generated for this media.';
  if(details.length&&(artwork||person||landmarks.length))sentence+=` Other detected details may include ${humanList(details)}.`;
  return `${sentence} This description is machine-generated and may be incomplete or incorrect.`;
};
const cleanContext=(value:string)=>value.replace(/\b(?:dps|damage|support|healer)\s+build\b.*$/i,'').replace(/\s+/g,' ').trim();

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
  const contextHints=new Map<string,{label:string;score:number;count:number}>();
  const addAnnotation=(target:Map<string,{label:string;score:number;count:number}>,label:string|undefined,score=0)=>{
    const clean=label?.replace(/\s+/g,' ').trim().slice(0,100);if(!clean)return;
    const key=clean.toLocaleLowerCase('en');const current=target.get(key);
    if(current){current.count++;current.score=Math.max(current.score,score);}
    else target.set(key,{label:clean,score,count:1});
  };
  for(const item of payload.responses??[]){
    if(item.error?.message)continue;
    for(const label of item.webDetection?.bestGuessLabels??[])addAnnotation(contextHints,cleanContext(label.label??''),0.7);
    for(const entity of item.webDetection?.webEntities??[])if((entity.score??0)>=0.65)addAnnotation(contextHints,entity.description,entity.score);
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
    .filter(match=>match.kind==='full'||match.frameCount>=2||files.length===1)
    .sort((a,b)=>Number(b.kind==='full')-Number(a.kind==='full')||b.frameCount-a.frameCount)
    .slice(0,5);
  const summary=ranked.length
    ? ranked[0]!.kind==='full'
      ? `${ranked.length} possible source ${ranked.length===1?'lead was':'leads were'} found. The strongest lead is a page where Google detected a matching image. Manual review is still required; this does not establish original authorship.`
      : `${ranked.length} possible partial ${ranked.length===1?'match was':'matches were'} found for this image. These weaker leads can result from crops, compression, embedded recommendations, or visually similar content and require careful manual review.`
    : `No sufficiently strong source match was found. Weak visual similarities were omitted because they can be unrelated. This does not prove that the media is original or previously unpublished.`;
  const rankedLandmarks=[...landmarks.values()].sort((a,b)=>b.count-a.count||b.score-a.score).map(item=>item.label).slice(0,2);
  const rankedLabels=[...labels.values()].sort((a,b)=>b.count-a.count||b.score-a.score).map(item=>item.label).filter(label=>!rankedLandmarks.some(landmark=>landmark.toLocaleLowerCase('en')===label.toLocaleLowerCase('en'))).slice(0,8);
  const rankedContext=[...contextHints.values()].sort((a,b)=>b.count-a.count||b.score-a.score).map(item=>item.label).filter(Boolean).slice(0,3);
  const description=naturalDescription(rankedLabels,rankedLandmarks);
  const context=rankedContext.length?`Google's web context suggests a possible connection to ${humanList(rankedContext)}. This is a contextual clue, not a confirmed identification or source attribution.`:undefined;
  return{summary,description,...(context?{context}:{}),matches:ranked,labels:rankedLabels};
}

export type SearchMedia =
  | {type:'video'; urls:[string]; declaredDuration?:number}
  | {type:'gif'; urls:[string]; declaredDuration?:number}
  | {type:'image'; urls:[string]}
  | {type:'gallery'; urls:string[]};

type PostMedia = {
  url:string;
  gallery:{url:string;status:number}[];
  secureMedia?:{redditVideo?:{fallbackUrl?:string;duration?:number;transcodingStatus?:string;isGif?:boolean}};
};

const REDDIT_IMAGE_HOSTS=new Set(['i.redd.it','preview.redd.it']);
const isRedditImage=(raw:string)=>{try{const url=new URL(raw);return url.protocol==='https:'&&REDDIT_IMAGE_HOSTS.has(url.hostname.toLowerCase());}catch{return false;}};
const isDirectGif=(raw:string)=>{try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/\.gif$/i.test(url.pathname);}catch{return false;}};

export function detectPostMedia(post:PostMedia):SearchMedia{
  const video=post.secureMedia?.redditVideo;
  if(video?.fallbackUrl){
    if(video.transcodingStatus&&video.transcodingStatus!=='completed')throw new Error('Reddit is still processing this video. Try again later.');
    return{type:video.isGif?'gif':'video',urls:[video.fallbackUrl],declaredDuration:video.duration};
  }
  const galleryUrls=post.gallery.filter(item=>item.status===1&&isRedditImage(item.url)).map(item=>item.url);
  if(galleryUrls.length)return{type:'gallery',urls:[...new Set(galleryUrls)]};
  if(isDirectGif(post.url))return{type:'gif',urls:[post.url]};
  if(isRedditImage(post.url))return{type:'image',urls:[post.url]};
  throw new Error('This post does not contain a supported native Reddit image, gallery, or video.');
}

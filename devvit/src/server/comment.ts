export type ProviderLink = { name: string; url: string };
export type SourceAnalysis={summary:string;description?:string;matches:{url:string;title:string;frameCount:number;kind:'full'|'partial'}[];labels:string[]};
const markdownLabel=(value:string)=>value.replace(/[\[\]\\]/g,'').slice(0,160);
const markdownUrl=(value:string)=>value.replace(/\(/g,'%28').replace(/\)/g,'%29');

export function buildComment(subreddit: string, providers: ProviderLink[], analysis:SourceAnalysis): string {
  const links = providers.map(({name,url}) => `[${name}](${url})`).join(' | ');
  const modmail = `https://www.reddit.com/message/compose?to=%2Fr%2F${encodeURIComponent(subreddit)}`;
  return [
    'This is an automatic comment used to help identify possible sources of this post’s media.',
    '',
    '**What may be visible:**',
    '',
    analysis.description||'No reliable visual description could be generated for this media.',
    '',
    '**Automatic source check:**',
    '',
    analysis.summary,
    ...(analysis.matches.length?['',...analysis.matches.slice(0,3).map((match,index)=>`${index+1}. [${markdownLabel(match.title||new URL(match.url).hostname)}](${markdownUrl(match.url)}) — matched ${match.frameCount} ${match.frameCount===1?'image':'images'}`)]:[]),
    '',
    '**Reverse Source Search:**',
    '',
    links,
    '',
    `I am a bot, and this action was performed automatically. [Please contact the moderators of this subreddit](${modmail}) if you have any questions or concerns.`,
    '',
    '*Search results may show earlier appearances or related images; they do not by themselves establish the original source.*'
  ].join('\n');
}

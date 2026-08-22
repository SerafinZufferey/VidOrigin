export type Provider={slug:string;name:string;search:(imageUrl:string)=>string};
export const providers:Provider[]=[
  {slug:'google-lens',name:'Google Lens',search:u=>`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}`},
  {slug:'saucenao',name:'SauceNAO',search:u=>`https://saucenao.com/search.php?url=${encodeURIComponent(u)}`},
  {slug:'yandex',name:'Yandex Images',search:u=>`https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}`},
  {slug:'tineye',name:'TinEye',search:u=>`https://tineye.com/search?url=${encodeURIComponent(u)}`}
];
export const providerBySlug=(slug:string)=>providers.find(p=>p.slug===slug);

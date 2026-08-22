import{describe,expect,it}from'vitest';import{detectPostMedia}from'./media.js';
const base={url:'https://www.reddit.com/r/test/comments/abc/post',gallery:[]};
describe('automatic media type detection',()=>{
  it('detects a single image post',()=>expect(detectPostMedia({...base,url:'https://i.redd.it/original.png'})).toEqual({type:'image',urls:['https://i.redd.it/original.png']}));
  it('detects a Reddit gallery and keeps valid images',()=>expect(detectPostMedia({...base,gallery:[{url:'https://preview.redd.it/a.jpg',status:1},{url:'https://i.redd.it/b.png',status:1},{url:'https://i.redd.it/failed.jpg',status:2}]})).toEqual({type:'gallery',urls:['https://preview.redd.it/a.jpg','https://i.redd.it/b.png']}));
  it('detects a native video before image fields',()=>expect(detectPostMedia({...base,url:'https://i.redd.it/poster.jpg',secureMedia:{redditVideo:{fallbackUrl:'https://v.redd.it/id/video.mp4',duration:12,transcodingStatus:'completed'}}})).toEqual({type:'video',urls:['https://v.redd.it/id/video.mp4'],declaredDuration:12}));
  it('detects a native Reddit GIF',()=>expect(detectPostMedia({...base,secureMedia:{redditVideo:{fallbackUrl:'https://v.redd.it/id/video.mp4',duration:4,transcodingStatus:'completed',isGif:true}}})).toEqual({type:'gif',urls:['https://v.redd.it/id/video.mp4'],declaredDuration:4}));
  it('detects an i.redd.it GIF',()=>expect(detectPostMedia({...base,url:'https://i.redd.it/animation.gif'})).toEqual({type:'gif',urls:['https://i.redd.it/animation.gif']}));
  it('detects a direct external HTTPS GIF',()=>expect(detectPostMedia({...base,url:'https://media.example.org/animation.gif'})).toEqual({type:'gif',urls:['https://media.example.org/animation.gif']}));
  it('rejects an insecure external GIF',()=>expect(()=>detectPostMedia({...base,url:'http://media.example.org/animation.gif'})).toThrow());
  it('rejects unsupported posts',()=>expect(()=>detectPostMedia(base)).toThrow(/supported native Reddit/));
  it('does not classify an external image URL as a Reddit image',()=>expect(()=>detectPostMedia({...base,url:'https://example.com/image.jpg'})).toThrow());
});

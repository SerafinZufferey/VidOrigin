import {describe,expect,it} from 'vitest';
import {buildComment} from './comment.js';
describe('buildComment',()=>it('uses one provider link, automatic findings, and dynamic modmail',()=>{const text=buildComment('Test Sub',[{name:'TinEye',url:'https://x.test'}],{summary:'One possible match was found.',matches:[{url:'https://source.test/post',title:'Possible source',frameCount:2,kind:'partial'}],labels:[]});expect(text.match(/TinEye/g)).toHaveLength(1);expect(text).toContain('One possible match');expect(text).toContain('[Possible source]');expect(text).toContain('to=%2Fr%2FTest%20Sub');}));

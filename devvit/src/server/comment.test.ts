import {describe,expect,it} from 'vitest';
import {buildComment} from './comment.js';
describe('buildComment',()=>it('uses one provider link and dynamic modmail',()=>{const text=buildComment('Test Sub',[{name:'TinEye',url:'https://x.test'}]);expect(text.match(/TinEye/g)).toHaveLength(1);expect(text).toContain('to=%2Fr%2FTest%20Sub');}));

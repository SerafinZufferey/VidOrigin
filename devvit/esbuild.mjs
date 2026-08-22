import { build } from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[path.join(here,'src/server/index.ts')],outfile:path.join(here,'dist/server/index.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',sourcemap:true});

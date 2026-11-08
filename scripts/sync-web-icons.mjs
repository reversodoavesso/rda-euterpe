/** Synchronize the official DS CSS, tokens and web icon runtime as one release. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ds=path.resolve(root,'../rda-ds');
const digest=data=>createHash('sha256').update(data).digest('hex');
const manifest=JSON.parse(await readFile(path.join(ds,'cdn/design-system.manifest.json'),'utf8'));
const css=await readFile(path.join(ds,'cdn/design-system.css'));
if(digest(css)!==manifest.sha256) throw new Error('Official DS CSS integrity mismatch. Build rda-ds before synchronizing.');
await writeFile(path.join(root,'web/dist/rda-ds.css'),css);
await writeFile(path.join(root,'web/dist/rda-tokens.css'),await readFile(path.join(ds,'cdn/tokens.css')));
const module=await readFile(path.join(ds,'dist/web/icons.js'),'utf8');
const data=await readFile(path.join(ds,'dist/components/Icon/icons-data.js'),'utf8');
const rewritten=module.replace('../components/Icon/icons-data.js','./rda-icons-data.js').replace(/\/\/# sourceMappingURL=.*$/gm,'');
await writeFile(path.join(root,'web/dist/rda-icons.js'),rewritten);
await writeFile(path.join(root,'web/dist/rda-icons-data.js'),data.replace(/\/\/# sourceMappingURL=.*$/gm,''));
const pkg=JSON.parse(await readFile(path.join(ds,'package.json'),'utf8'));
await writeFile(path.join(root,'web/dist/rda-icons-provenance.json'),JSON.stringify({package:pkg.name,version:pkg.version,
 cssSha256:manifest.sha256,sourceSha256:manifest.sourceSha256,
 tokensSha256:digest(await readFile(path.join(root,'web/dist/rda-tokens.css'))),
 runtimeSha256:digest(rewritten),catalogSha256:digest(data.replace(/\/\/# sourceMappingURL=.*$/gm,'')),
 sourceModuleSha256:digest(module),sourceCatalogSha256:digest(data)},null,2)+'\n');
console.log(`Official RDA DS ${pkg.version} CSS, tokens and icons synchronized.`);

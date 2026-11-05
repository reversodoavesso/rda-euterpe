/** Copy the official DS web component and icon catalog without introducing custom SVG artwork. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ds=path.resolve(root,'../rda-ds');
const module=await readFile(path.join(ds,'dist/web/icons.js'),'utf8');
const data=await readFile(path.join(ds,'dist/components/Icon/icons-data.js'),'utf8');
const rewritten=module.replace('../components/Icon/icons-data.js','./rda-icons-data.js').replace(/\/\/# sourceMappingURL=.*$/gm,'');
await writeFile(path.join(root,'web/dist/rda-icons.js'),rewritten);
await writeFile(path.join(root,'web/dist/rda-icons-data.js'),data.replace(/\/\/# sourceMappingURL=.*$/gm,''));
const pkg=JSON.parse(await readFile(path.join(ds,'package.json'),'utf8'));
await writeFile(path.join(root,'web/dist/rda-icons-provenance.json'),JSON.stringify({package:pkg.name,version:pkg.version,
 sourceModuleSha256:createHash('sha256').update(module).digest('hex'),sourceCatalogSha256:createHash('sha256').update(data).digest('hex')},null,2)+'\n');
console.log('Official RDA DS web icons synchronized.');

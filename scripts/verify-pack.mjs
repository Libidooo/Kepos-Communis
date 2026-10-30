import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
function markdownLinks(text){
 let fence;
 const links=[],references=new Map();
 const label=value=>value.trim().replace(/\s+/g,' ').toLowerCase();
 // Code examples and comments are not navigable documentation links.
 const source=text.split(/\r?\n/).map(line=>{
  const content=line.replace(/^(?: {0,3}>[ \t]?)+/,'');
  const marker=content.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
  if(fence){
   if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=undefined;
   return '';
  }
  if(marker){fence=marker[1];return '';}
  return /^(?: {4}|\t)/.test(content)?'':content;
 }).join('\n').replace(/<!--[\s\S]*?-->|<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
  .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,'')
  .replace(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\r\n]+)>|(\S+)).*$/gm,(match,id,angle,bare)=>{
   if(id.startsWith('^'))return match;
   references.set(label(id),angle??bare);return '';
  });
 for(const match of source.matchAll(/(?<!\\)\]\(\s*(?:<([^>\r\n]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g))links.push(match[1]??match[2]);
 for(const match of source.matchAll(/(?<!\\)!?\[([^\]\r\n]*)\](?:[ \t]*\[([^\]\r\n]*)\])?/g)){
  if(source[match.index+match[0].length]==='(')continue;
  const target=references.get(label(match[2]||match[1]));
  if(target!==undefined)links.push(target);
 }
 for(const tag of source.matchAll(/<(img|a)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  for(const attribute of tag[0].matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)){
   if(attribute[1].toLowerCase()===(tag[1].toLowerCase()==='img'?'src':'href'))links.push(attribute[2]??attribute[3]??attribute[4]);
  }
 }
 return links;
}
function checkMarkdownLinks(root,names){
 const files=names.filter(name=>/\.md$/i.test(name)),packed=new Set(names),missing=[];
 const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
 let relativeLinks=0;
 for(const file of files){
  for(const link of markdownLinks(fs.readFileSync(path.join(root,file),'utf8'))){
   const value=link.replace(/\\([\\`*{}[\]()#+\-.!_<>])/g,'$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(match,entity)=>{
    const key=entity.toLowerCase();
    if(key[0]!=='#')return entities[key];
    const code=key[1]==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
    return code<=0x10ffff?String.fromCodePoint(code):match;
   }).trim();
   if(!value||/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value))continue;
   const location=value.split(/[?#]/,1)[0];
   if(!location)continue;
   relativeLinks++;
   let decoded;
   try{decoded=decodeURIComponent(location);}catch{missing.push(file+' -> '+link+' (invalid URL encoding)');continue;}
   const target=path.resolve(path.dirname(path.join(root,file)),decoded);
   const relative=path.relative(root,target).split(path.sep).join('/');
   // Check exact archive spelling as well as existence, even on Windows.
   if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('../')||(!packed.has(relative)&&relative!==''&&!names.some(name=>name.startsWith(relative+'/')))||!fs.existsSync(target))missing.push(file+' -> '+link);
  }
 }
 assert.equal(missing.length,0,'Broken package documentation links:\n'+missing.join('\n'));
 return {markdownFiles:files.length,relativeLinks,anchorCheck:'not checked; verify Markdown fragments and HTML ids separately'};
}
const project=path.resolve(import.meta.dirname,'..');
const npm=process.env.npm_execpath;
if(!npm)throw Error('Run this verification using npm run test:package');
assert.ok(fs.existsSync(path.join(project,'node_modules')),'Missing project node_modules (this check does not install dependencies)');
fs.mkdirSync(path.join(project,'recovery'),{recursive:true});
// Keep scratch below the project to reuse its node_modules, not a clean install.
const scratch=fs.mkdtempSync(path.join(project,'recovery','pack-test-'));
try{
 const archive=path.join(scratch,'archive'),extracted=path.join(scratch,'extracted'),home=path.join(scratch,'home'),cache=path.join(scratch,'npm-cache');
 for(const directory of [archive,extracted,home,cache])fs.mkdirSync(directory);
 const pack=spawnSync(process.execPath,[npm,'pack','--json','--ignore-scripts','--offline','--pack-destination',archive],{encoding:'utf8',windowsHide:true,cwd:project,env:{...process.env,npm_config_cache:cache}});
 assert.equal(pack.status,0,pack.error?.message||pack.stderr);
 const info=JSON.parse(pack.stdout)[0];
 assert.ok(typeof info.filename==='string'&&/^[^/\\]+\.tgz$/.test(info.filename),'Unexpected package archive filename');
 const required=['bin/kepos.cjs','dist/src/cli.js','dist/src/runtime/app.js','dist/terminal/index.js','dist/terminal/workers.js','dist/terminal/worker-host.cjs','dist/terminal/scheduler.js','themes/orbital-76.json','LICENSE','THIRD_PARTY_NOTICES.md',
  'README.md','docs/README.md','docs/product.md','docs/installation.md','docs/architecture.md','docs/brand-voice.md','docs/unified-scheduling.md','docs/media/readme-hero.svg','docs/media/workbench-map.svg'];
 const names=info.files.map(file=>file.path),packed=new Set(names);
 for(const name of required)assert.ok(packed.has(name),'Missing package file: '+name);
 const allowed=/^(bin\/|dist\/|themes\/|canvas\/|docs\/|package\.json$|README\.md$|SECURITY\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/;
 const forbidden=/(^|\/)(?:recovery|reports|node_modules|\.git|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|(?:auth|tokens?)\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.json|\.ya?ml|\.toml)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|key|p12|pfx|sqlite|db))(?:\/|$)/i;
 for(const name of names){
  assert.ok(name.split('/').every(part=>part&&part!=='.'&&part!=='..')&&!/[\\:\0]/.test(name),'Unsafe package path: '+name);
  assert.ok(allowed.test(name),'Unexpected packed file: '+name);
  assert.ok(!forbidden.test(name),'Sensitive or generated packed file: '+name);
 }
 const tar=createRequire(npm)('tar'),rejected=[];
 // Only regular manifest files/directories may enter the new extraction root.
 await tar.x({file:path.join(archive,info.filename),cwd:extracted,strict:true,preservePaths:false,filter:(name,entry)=>{
  const relative=entry.type==='Directory'?name.replace(/\/$/,''):name;
  const valid=entry.type==='File'?relative.startsWith('package/')&&packed.has(relative.slice(8)):
   entry.type==='Directory'&&(relative==='package'||relative.startsWith('package/')&&names.some(file=>file.startsWith(relative.slice(8)+'/')));
  if(!valid)rejected.push(name+' ('+entry.type+')');
  return valid;
 }});
 assert.equal(rejected.length,0,'Unexpected archive entries:\n'+rejected.join('\n'));
 const root=path.join(extracted,'package');
 for(const name of names)assert.ok(fs.lstatSync(path.join(root,name),{throwIfNoEntry:false})?.isFile(),'Missing extracted package file: '+name);
 const documentation=checkMarkdownLinks(root,names);
 const result=spawnSync(process.execPath,[path.join(root,'bin','kepos.cjs'),'doctor','--home',home,'--json'],{encoding:'utf8',windowsHide:true,cwd:project});
 assert.equal(result.status,0,result.error?.message||result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.architecture,'sdk');assert.equal(data.themeBundled,true);
 assert.equal(path.resolve(data.home),home);assert.equal(path.resolve(data.project),project);
 console.log(JSON.stringify({pass:true,version:info.version,packedFiles:names.length,packedBytes:info.size,architecture:data.architecture,documentation,dependencySource:'project node_modules (not a clean npm registry install)',modelCalls:0},null,2));
}finally{
 const resolved=path.resolve(scratch);
 if(path.dirname(resolved)!==path.resolve(project,'recovery')||!path.basename(resolved).startsWith('pack-test-'))throw Error('Unexpected package cleanup directory');
 fs.rmSync(resolved,{recursive:true,force:true});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchLocalSkills, skillsShSearch, resolveSkillOnline } from '../dist/terminal/skill-source.js';

test('local matching ranks installed skills by goal overlap',()=>{
 const catalog=[
  {name:'pdf',description:'PDF 文件处理'},
  {name:'risk-sentinel',description:'盯住项目风险并汇总成清单'},
  {name:'scribe',description:'documentation and meeting notes'},
 ];
 const hits=matchLocalSkills('盯住项目风险，每天汇总成清单',catalog);
 assert.equal(hits[0],'risk-sentinel');
 assert.equal(hits.includes('pdf'),false);
 const english=matchLocalSkills('write meeting notes',catalog);
 assert.equal(english[0],'scribe');
 assert.deepEqual(matchLocalSkills('完全无关的目标词',catalog.filter(s=>s.name==='pdf')),[]);
});

test('skills.sh search fetches SKILL.md across known nestings',async()=>{
 const calls=[];
 const fetchImpl=(async(url)=>{
  calls.push(String(url));
  if(String(url).startsWith('https://www.skills.sh/api/search'))return {ok:true,json:async()=>({skills:[{id:'a/b/risk-watch',source:'a/b',skillId:'risk-watch',installs:42}]})};
  if(String(url)==='https://raw.githubusercontent.com/a/b/HEAD/skills/risk-watch/SKILL.md')return {ok:true,text:async()=>'# risk watch skill'};
  return {ok:false,text:async()=>''};
 });
 const hits=await skillsShSearch('risk watch',3,8000,fetchImpl);
 assert.equal(hits.length,1);
 assert.equal(hits[0].skillId,'risk-watch');
 assert.match(hits[0].md,/risk watch skill/);
 assert.ok(calls.some(url=>url.includes('/HEAD/skills/risk-watch/SKILL.md')),'tries the nested layout');
});

test('online resolution installs a confident match and refuses a miss',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-skillsrc-'));
 const fetchImpl=(async(url)=>{
  if(String(url).startsWith('https://www.skills.sh/api/search'))return {ok:true,json:async()=>({skills:[{id:'a/b/risk-watch',source:'a/b',skillId:'risk-watch',installs:5}]})};
  if(String(url)==='https://raw.githubusercontent.com/a/b/HEAD/skills/risk-watch/SKILL.md')return {ok:true,text:async()=>'# risk watch skill'};
  return {ok:false,text:async()=>''};
 });
 const resolved=await resolveSkillOnline('risk-watch',dir,{fetchImpl});
 assert.ok(resolved,'confident match installs');
 const file=join(resolved.path,'SKILL.md');
 assert.ok(existsSync(file));
 assert.match(readFileSync(file,'utf8'),/risk watch/);
 const empty=mkdtempSync(join(tmpdir(),'kepos-skillsrc2-'));
 const miss=await resolveSkillOnline('totally-unknown-skill',empty,{fetchImpl:async()=>({ok:true,json:async()=>({skills:[]})})});
 assert.equal(miss,null);
 assert.equal(existsSync(join(empty,'skills','totally-unknown-skill','SKILL.md')),false);
});

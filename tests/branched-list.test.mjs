import test from 'node:test';
import assert from 'node:assert/strict';
const {branchedSpec}=await import('../dist/terminal/branched-list.js');

const project=(label='Kepos')=>({kind:'project',path:'T:/Kepos',label});
const session=(label='会话')=>({kind:'session',path:'T:/Kepos/s1',label});
const base={open:true,holdsActive:false,active:false,selected:false,supportsBg:true};

// BranchedMenu 的语法：末子项圆弯，其余分叉。
test('the last child curves away, earlier children fork',()=>{
  assert.equal(branchedSpec({row:session(),...base,isLastChild:false}).branch,'├─');
  assert.equal(branchedSpec({row:session(),...base,isLastChild:true}).branch,'╰─');
  assert.equal(branchedSpec({row:project(),...base,isLastChild:true}).branch,'','heads sit on the trunk, no branch');
});

// 当前会话 = reach 线：整条分支与标签同用强调色。
test('the active session draws its branch and label in the accent',()=>{
  const spec=branchedSpec({row:session(),...base,active:true,isLastChild:false});
  assert.equal(spec.branchToken,'accent');
  assert.equal(spec.labelToken,'accent');
  const idle=branchedSpec({row:session(),...base,isLastChild:false});
  assert.equal(idle.branchToken,'borderMuted');
  assert.equal(idle.labelToken,'dim');
});

// 滑动 marker 的静态等价物：只有"开放且含当前会话"的分组亮 ▎。
test('the rail lights up beside an open section that holds the active session',()=>{
  assert.equal(branchedSpec({row:project(),...base,holdsActive:true}).rail,'▎');
  assert.equal(branchedSpec({row:project(),...base,holdsActive:true}).railToken,'accent');
  assert.equal(branchedSpec({row:project(),...base}).rail,'│','no marker without the active session');
  assert.equal(branchedSpec({row:project(),...base,holdsActive:true,open:false}).rail,'│','nor when the section is folded');
  assert.equal(branchedSpec({row:session(),...base,holdsActive:true}).rail,'│','sessions never carry the marker');
});

// 折叠态靠颜色表达：头从 text 降到 dim（web 版 ink/muted 的对应）。
test('a folded head reads dimmer than an open one',()=>{
  assert.equal(branchedSpec({row:project(),...base,open:true}).labelToken,'text');
  assert.equal(branchedSpec({row:project(),...base,open:false}).labelToken,'dim');
});

// 有背景色能力时选中整行高亮，轨道保持贯通；没有时降级为轨道列的 ›（宽度不变）。
test('selection rides the background when supported, degrades to the rail otherwise',()=>{
  const withBg=branchedSpec({row:session(),...base,selected:true,supportsBg:true});
  assert.equal(withBg.selected,true);
  assert.equal(withBg.rail,'│','the rail stays continuous under a highlight');
  const noBg=branchedSpec({row:project(),...base,selected:true,supportsBg:false});
  assert.equal(noBg.rail,'›');
  assert.equal(noBg.railToken,'accent');
});

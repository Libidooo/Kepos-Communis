"""Real Windows ConPTY test for the selected Kepos extension (--smoke uses no model).
No additional packages required. Isolated workspace and session directory.
"""
import ctypes as C
from ctypes import wintypes as W
import os, json, tempfile, threading, time, re, sys, uuid, datetime, sqlite3, subprocess, shutil
k=C.WinDLL('kernel32',use_last_error=True)
H=W.HANDLE; SIZE=C.c_size_t
class COORD(C.Structure): _fields_=[('X',C.c_short),('Y',C.c_short)]
class SI(C.Structure):
 _fields_=[('cb',W.DWORD),('lpReserved',W.LPWSTR),('lpDesktop',W.LPWSTR),('lpTitle',W.LPWSTR),('dwX',W.DWORD),('dwY',W.DWORD),('dwXSize',W.DWORD),('dwYSize',W.DWORD),('dwXCountChars',W.DWORD),('dwYCountChars',W.DWORD),('dwFillAttribute',W.DWORD),('dwFlags',W.DWORD),('wShowWindow',W.WORD),('cbReserved2',W.WORD),('lpReserved2',C.c_void_p),('hStdInput',H),('hStdOutput',H),('hStdError',H)]
class SX(C.Structure): _fields_=[('StartupInfo',SI),('lpAttributeList',C.c_void_p)]
class PI(C.Structure): _fields_=[('hProcess',H),('hThread',H),('dwProcessId',W.DWORD),('dwThreadId',W.DWORD)]
k.CreatePipe.argtypes=[C.POINTER(H),C.POINTER(H),C.c_void_p,W.DWORD];k.CreatePipe.restype=W.BOOL
k.CreatePseudoConsole.argtypes=[COORD,H,H,W.DWORD,C.POINTER(H)];k.CreatePseudoConsole.restype=C.c_long
k.InitializeProcThreadAttributeList.argtypes=[C.c_void_p,W.DWORD,W.DWORD,C.POINTER(SIZE)]
k.UpdateProcThreadAttribute.argtypes=[C.c_void_p,W.DWORD,SIZE,C.c_void_p,SIZE,C.c_void_p,C.c_void_p]
k.CreateProcessW.argtypes=[W.LPCWSTR,W.LPWSTR,C.c_void_p,C.c_void_p,W.BOOL,W.DWORD,C.c_void_p,W.LPCWSTR,C.POINTER(SX),C.POINTER(PI)];k.CreateProcessW.restype=W.BOOL
k.ReadFile.argtypes=[H,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p]
k.WriteFile.argtypes=[H,C.c_void_p,W.DWORD,C.POINTER(W.DWORD),C.c_void_p]
k.ResizePseudoConsole.argtypes=[H,COORD];k.ResizePseudoConsole.restype=C.c_long
k.CloseHandle.argtypes=[H];k.TerminateProcess.argtypes=[H,W.UINT];k.ClosePseudoConsole.argtypes=[H]
ri,wi,ro,wo=H(),H(),H(),H()
assert k.CreatePipe(C.byref(ri),C.byref(wi),None,0)
assert k.CreatePipe(C.byref(ro),C.byref(wo),None,0)
pc=H();hr=k.CreatePseudoConsole(COORD(150,45),ri,wo,0,C.byref(pc));assert hr==0,hr
size=SIZE();k.InitializeProcThreadAttributeList(None,1,0,C.byref(size));attrs=C.create_string_buffer(size.value)
assert k.InitializeProcThreadAttributeList(attrs,1,0,C.byref(size))
assert k.UpdateProcThreadAttribute(attrs,0,0x00020016,pc,C.sizeof(H),None,None)
sx=SX();sx.StartupInfo.cb=C.sizeof(SX);sx.lpAttributeList=C.cast(attrs,C.c_void_p);pi=PI()
base=os.path.dirname(os.path.abspath(__file__));workspace=subprocess.check_output(['node','-e',"console.log(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'orbital-conpty-')))"],cwd=base,encoding='utf8').strip();os.environ['ORBITAL_HOME']=os.path.join(workspace,'config')
project_b=os.path.join(workspace,'project-b');os.makedirs(project_b)
os.makedirs(os.path.join(workspace,'sessions'));os.makedirs(os.environ['ORBITAL_HOME'])
json.dump({'projects':[project_b],'agents':[{'id':'review-a','name':'审查A','model':os.environ.get('PI_MODEL','gpt-6.1-sol'),'provider':os.environ.get('PI_PROVIDER','openai-codex'),'role':'只回复任务指定的标记，不调用工具。'},{'id':'review-b','name':'审查B','model':os.environ.get('PI_MODEL','gpt-6.1-sol'),'provider':os.environ.get('PI_PROVIDER','openai-codex'),'role':'只回复任务指定的标记，不调用工具。'}],'folded':[],'drafts':{}}, open(os.path.join(os.environ['ORBITAL_HOME'],'workspace.json'),'w',encoding='utf8'))
now=datetime.datetime.now(datetime.timezone.utc).isoformat();sid=str(uuid.uuid4());fixture_b=os.path.join(workspace,'sessions','fixture-b.jsonl')
with open(fixture_b,'w',encoding='utf8') as f:
 for obj in [{'type':'session','version':3,'id':sid,'timestamp':now,'cwd':project_b},{'type':'session_info','id':'info-b','parentId':None,'timestamp':now,'name':'Project B test'},{'type':'message','id':'user-b','parentId':'info-b','timestamp':now,'message':{'role':'user','content':'B_HISTORY_FIXTURE','timestamp':int(time.time()*1000)}}]: f.write(json.dumps(obj)+'\n')
root=subprocess.check_output(['node','-e','console.log(require("./runtime-paths.cjs").resolveEngine())'],cwd=base,encoding='utf8').strip();extension=os.path.join(os.environ.get('KEPOS_EXTENSION_DIR',os.path.join(base,'terminal')),'index.ts');os.environ['KEPOS_APP']='1'
skill_dir=os.path.join(workspace,'fixture-skill');os.makedirs(skill_dir)
open(os.path.join(skill_dir,'SKILL.md'),'w',encoding='utf8').write('---\nname: fixture-skill\ndescription: Local command acceptance fixture.\n---\nWhen invoked, read these instructions and only answer SKILL_COMMAND_OK. Do not call external services.\n')
node=shutil.which('node');assert node,'Node.js is required'
command=f'"{node}" "{root}/dist/cli.js" --no-extensions --extension "{extension}" --no-skills --skill "{skill_dir}" --no-context-files --no-mcp --no-approve --offline --session-dir "{workspace}/sessions" --name "ConPTY smoke" /kepos'
if '--sdk' in sys.argv:
 os.environ.pop('ORBITAL_HOME',None);os.environ.pop('ORBITAL_DATA_DIR',None)
 for key in ['KEPOS_HOME','KEPOS_DATA_DIR','KEPOS_AGENT_DIR','PI_CODING_AGENT_DIR']:os.environ.pop(key,None)
 sdk_home=os.path.join(workspace,'kepos-home')
 if '--profiles' in sys.argv:subprocess.check_call([node,os.path.join(base,'tests','fixtures','profile-ui.mjs'),sdk_home])
 command=f'"{node}" "{base}/bin/kepos.cjs" --home "{sdk_home}"'
command=os.environ.get('ORBITAL_TEST_COMMAND','cmd.exe /d /s /c "chcp 65001>nul & '+command+'"')
k.GetStdHandle.argtypes=[W.DWORD];k.GetStdHandle.restype=H;k.SetStdHandle.argtypes=[W.DWORD,H]
std_ids=[-10 & 0xffffffff,-11 & 0xffffffff,-12 & 0xffffffff]
old_std=[k.GetStdHandle(i) for i in std_ids]
for i in std_ids:k.SetStdHandle(i,None)
created=k.CreateProcessW(None,C.create_unicode_buffer(command),None,None,False,0x00080000,None,workspace,C.byref(sx),C.byref(pi))
for i,h in zip(std_ids,old_std):k.SetStdHandle(i,h)
assert created,C.get_last_error()
k.CloseHandle(ri);k.CloseHandle(wo)
chunks=[];lock=threading.Lock();stopped=False

def write(s):
 b=s.encode('utf-8');n=W.DWORD();assert k.WriteFile(wi,b,len(b),C.byref(n),None)
def read_loop():
 buf=C.create_string_buffer(65536);n=W.DWORD()
 while k.ReadFile(ro,buf,len(buf),C.byref(n),None) and n.value:
  data=buf.raw[:n.value]
  with lock: chunks.append(data)
  if b'\x1b[6n' in data:
   try: write('\x1b[1;1R')
   except: pass
threading.Thread(target=read_loop,daemon=True).start()
def workspace_config():
 with sqlite3.connect(os.path.join(workspace,'orbital.sqlite')) as db:
  return json.loads(db.execute("SELECT value FROM kv WHERE key='workspace'").fetchone()[0])
def worker_tasks():
 with sqlite3.connect(os.path.join(workspace,'orbital.sqlite')) as db:
  return [json.loads(row[0]) for row in db.execute("SELECT task FROM workers ORDER BY json_extract(task,'$.started')")]
def output():
 with lock: return b''.join(chunks).decode('utf-8','replace')
def wait_for(token,seconds=45,start=0):
 until=time.time()+seconds
 while time.time()<until:
  if token in output()[start:]:return
  time.sleep(.15)
 raise AssertionError('Missing token: '+repr(token)+'\nTail:\n'+output()[-6000:])
try:
 time.sleep(3)
 if os.environ.get('ORBITAL_PROBE'):
  write('hello\r');time.sleep(5);print(repr(output()));sys.exit(0)
 write('\x1b[?1;2c\x1b[1;1R')
 wait_for('输入区',35)
 if '--smoke' in sys.argv:
  start=len(output());write('\x1bOP');wait_for('操作指南',10,start);write('\x1bOP');time.sleep(.4)
  start=len(output());write('\x1bOQ');wait_for('操作菜单',10,start);write('\x1b');time.sleep(.4)
  if '--profiles' in sys.argv:
   start=len(output());write('\x1bOQ');wait_for('操作菜单',10,start);write('\x1b[B'*3+'\r');wait_for('编辑成员',10,start);write('\r')
   time.sleep(.3);write('\x1b[B'*2+'\r');wait_for('修订历史',10,start);write('\x1b[B\r');wait_for('FIRST_ROLE_UI_FIXTURE',10,start);write('\r');wait_for('配置已恢复',10,start)
   with sqlite3.connect(os.path.join(sdk_home,'data','orbital.sqlite')) as db:
    saved=json.loads(db.execute("SELECT value FROM kv WHERE key='workspace'").fetchone()[0])
   assert saved['agents'][0]['role']=='FIRST_ROLE_UI_FIXTURE','Revision restore did not reach persisted config'
   assert saved['agents'][0]['tools']==['read'],'Tool preset was not restored'
  start=len(output());write('\x1b[19~');wait_for('全局任务',10,start);write('\x1bOR');time.sleep(.3)
  start=len(output());write('\x1b[20~');wait_for('长程计划',10,start);write('\x1b[20~');time.sleep(.3)
  start=len(output());write('\x18');wait_for('输入区',15,start)
  start=len(output());write('/reload\r');wait_for('扩展已重载',20,start);wait_for('输入区',20,start)
  session_folder=os.path.join(sdk_home,'data','sessions') if '--sdk' in sys.argv else os.path.join(workspace,'sessions')
  for filename in os.listdir(session_folder):
   if not filename.endswith('.jsonl'):continue
   with open(os.path.join(session_folder,filename),encoding='utf8') as transcript:
    records=[json.loads(line) for line in transcript if line.strip()]
   assert not any(row.get('message',{}).get('role')=='assistant' for row in records),'Unexpected assistant turn in model-free smoke'
   assert not any('/reload' in json.dumps(row.get('message',{})) for row in records),'Reload was sent as a message'
  json.dump({'pass':True,'workspace':workspace,'extension':extension,'architecture':'sdk' if '--sdk' in sys.argv else 'extension','model_calls':False,'profile_restore':'--profiles' in sys.argv,'checks':['startup','help','owned menu','global tasks','missions monitor','abort and reopen','true hot reload']},open(os.path.join(base,'conpty-sdk-smoke-result.json' if '--sdk' in sys.argv else 'conpty-smoke-result.json'),'w',encoding='utf8'),ensure_ascii=False,indent=2)
  print('PASS real ConPTY startup, help, owned menu, abort/reopen and hot reload; no model prompts')
  sys.exit(0)
 token='CONPTY-'+str(int(time.time()))
 write('请只回复 '+token+'，不要调用工具。\r')
 wait_for('主 Agent',60)
 wait_for(token,60)
 # Require finalized assistant message in the actual session JSONL, not echoed input.
 until=time.time()+65;found=False;session_file=None
 while time.time()<until:
  folder=os.path.join(workspace,'sessions')
  if os.path.isdir(folder):
   for f in os.listdir(folder):
    if not f.endswith('.jsonl'):continue
    p=os.path.join(folder,f)
    try:
     for line in open(p,encoding='utf8'):
      obj=json.loads(line);m=obj.get('message',{})
      if m.get('role')=='assistant' and token in json.dumps(m,ensure_ascii=False): found=True;session_file=p
    except (ValueError,OSError):pass
  if found:break
  time.sleep(.25)
 assert found,'No finalized assistant response persisted; screen echo is not sufficient.'
 # Verify real system clipboard, not only a copy button acknowledgement.
 user32=C.WinDLL('user32',use_last_error=True);user32.OpenClipboard.argtypes=[H];user32.GetClipboardData.argtypes=[W.UINT];user32.GetClipboardData.restype=H
 k.GlobalLock.argtypes=[H];k.GlobalLock.restype=C.c_void_p;k.GlobalUnlock.argtypes=[H]
 def clipboard_text():
  if not user32.OpenClipboard(None):return ''
  try:
   h=user32.GetClipboardData(13)
   if not h:return ''
   ptr=k.GlobalLock(h)
   if not ptr:return ''
   try:return C.wstring_at(ptr)
   finally:k.GlobalUnlock(h)
  finally:user32.CloseClipboard()
 time.sleep(.4);write('\x1b[18~');until=time.time()+8
 while time.time()<until and token not in clipboard_text():time.sleep(.1)
 assert token in clipboard_text(),'F7 did not copy actual assistant text to system clipboard'
 # Unknown slash is rejected locally and never stored as a user prompt.
 start=len(output());write('/does_not_exist_OrbitalCheck\r');wait_for('未知命令',8,start);time.sleep(.2)
 assert '/does_not_exist_OrbitalCheck' not in open(session_file,encoding='utf8').read(),'Unknown command reached model history'
 write('\x15');time.sleep(.2)
 # Skill names are resolved by Pi, not treated as literal chat.
 write('/skill:fixture-skill\r');until=time.time()+60;skill_ok=False
 while time.time()<until:
  for line in open(session_file,encoding='utf8'):
   row=json.loads(line);m=row.get('message',{})
   if m.get('role')=='assistant' and 'SKILL_COMMAND_OK' in json.dumps(m,ensure_ascii=False):skill_ok=True
  if skill_ok:break
  time.sleep(.2)
 assert skill_ok,'Registered skill did not execute through Pi expansion'
 time.sleep(.5)
 # Normal letters must not trigger navigation shortcuts.
 write('pna');time.sleep(.2);write('\x7f\x7f\x7f')
 # Open help, close help, enter project focus, return to editor.
 write('\x1bOP');wait_for('操作指南',5);write('\x1bOP');time.sleep(.3)
 write('\x1b[17~');wait_for('项目区',5);write('\x1b[17~');write('\x1b[17~');time.sleep(.3)
 # Exit desk, reopen, and verify history remains rendered.
 write('\x1b');time.sleep(.7);start=len(output());write('/orbital\r');wait_for(token,10,start)
 # Switch to another project using the real right-hand session list.
 write('\x1b[17~');time.sleep(.2)
 write('\x1b[B\x1b[B\x1b[B');time.sleep(.3)
 start=len(output());write('\r')
 wait_for('B_HISTORY_FIXTURE',25,start)
 token_b='PROJECT-B-'+str(int(time.time()))
 write('请只回复 '+token_b+'，不要调用工具。\r')
 until=time.time()+65;found_b=False
 while time.time()<until:
  try:
   for line in open(fixture_b,encoding='utf8'):
    obj=json.loads(line);m=obj.get('message',{})
    if m.get('role')=='assistant' and token_b in json.dumps(m,ensure_ascii=False):found_b=True
  except (ValueError,OSError):pass
  if found_b:break
  time.sleep(.25)
 assert found_b,'Cross-project switch did not accept/persist a response in Project B'
 # Real supervisor -> two independent child Agents -> supervisor result loop.
 time.sleep(.6)
 marker_a='SUBA-'+str(int(time.time()));marker_b='SUBB-'+str(int(time.time()))
 write('请必须调用 orbital_delegate 工具，并行给审查A和审查B各一个任务，seconds 都设为60：审查A只回复 '+marker_a+'，审查B只回复 '+marker_b+'。收到两个结果后汇总，不要自己伪造标记。\r')
 task_file=os.path.join(workspace,'tasks','tasks.json');until=time.time()+120;tasks=[]
 while time.time()<until:
  try:tasks=worker_tasks()
  except (ValueError,OSError):pass
  if len(tasks)>=2 and all(t['status']=='完成' for t in tasks[-2:]):break
  time.sleep(.3)
 assert len(tasks)>=2 and all(t['status']=='完成' for t in tasks[-2:]),'Delegated tasks failed: '+json.dumps(tasks,ensure_ascii=False)
 assert any(marker_a in t['output'] for t in tasks) and any(marker_b in t['output'] for t in tasks),'Missing real child model results'
 assert all(t['limit']<=240 for t in tasks)
 until=time.time()+50;supervised=False
 while time.time()<until:
  try:
   for line in open(fixture_b,encoding='utf8'):
    obj=json.loads(line);m=obj.get('message',{});blocks=m.get('content',[])
    text='\n'.join(b.get('text','') for b in blocks if isinstance(b,dict)) if isinstance(blocks,list) else str(blocks)
    if m.get('role')=='assistant' and m.get('stopReason')=='stop' and marker_a in text and marker_b in text:supervised=True
  except (ValueError,OSError):pass
  if supervised:break
  time.sleep(.25)
 assert supervised,'Supervisor did not produce a finalized summary of both child results'
 time.sleep(.4)
 wait_for(marker_a,20);wait_for(marker_b,20)
 write('\x1bOR');wait_for('项目任务',10)
 write('\x1bOR');time.sleep(.3)
 # Use the actual full-screen overlay and mouse hit targets.
 start=len(output());write('\x1b[<0;3;45M\x1b[<0;3;45m');wait_for('操作指南',8,start);write('\x1bOP');time.sleep(.3)
 # Exercise the actual F2 -> new conversation workflow and automatic desk re-open.
 start=len(output());write('\x1bOQ');wait_for('操作菜单',8,start);write('\x1b[B\r');time.sleep(.4)
 start=len(output());write('New Conversation Test\r');wait_for('New Conversation Test',20,start);time.sleep(.6)
 token_new='NEW-SESSION-'+str(int(time.time()));write('请只回复 '+token_new+'，不要调用工具。\r')
 until=time.time()+60;new_ok=False
 while time.time()<until:
  for f in os.listdir(os.path.join(workspace,'sessions')):
   if not f.endswith('.jsonl') or f=='fixture-b.jsonl':continue
   try:
    for line in open(os.path.join(workspace,'sessions',f),encoding='utf8'):
     obj=json.loads(line);m=obj.get('message',{})
     if m.get('role')=='assistant' and token_new in json.dumps(m,ensure_ascii=False):new_ok=True
   except (ValueError,OSError):pass
  if new_ok:break
  time.sleep(.25)
 assert new_ok,'F2-created new conversation did not persist a model response'
 time.sleep(.5)
 # Manually dispatched workers must survive session/project replacement, without injecting results into the wrong conversation.
 marker_bg='BACKGROUND-'+str(int(time.time()))
 start=len(output());write('\x1bOQ');wait_for('操作菜单',8,start);write('\x1b[B'*4+'\r');time.sleep(.3);write('\r');time.sleep(.3)
 write('请只回复 '+marker_bg+'，不要调用工具。\r');time.sleep(.3);write('\r')
 until=time.time()+10;running=False
 while time.time()<until:
  try: tasks=worker_tasks()
  except (ValueError,OSError):tasks=[]
  if len(tasks)>=3 and tasks[-1]['status'] not in ['完成','失败','已取消','超时']:running=True;break
  time.sleep(.1)
 assert running,'Manual child task did not start'
 time.sleep(.2);write('\x1b[17~');write('\x1b[B'*100);start=len(output());write('\r');wait_for('ConPTY smoke',20,start)
 until=time.time()+90
 while time.time()<until:
  tasks=worker_tasks()
  if tasks[-1]['status'] in ['完成','失败','已取消','超时']:break
  time.sleep(.2)
 assert tasks[-1]['status']=='完成','Background task was cancelled during project switch: '+str(tasks[-1])
 assert marker_bg in tasks[-1]['output'],'Missing background child model output'
 assert marker_bg not in open(session_file,encoding='utf8').read(),'Background result was injected into the wrong project conversation'
 # Dynamic terminal resize, plus a final screen-state snapshot.
 import importlib.util
 spec=importlib.util.spec_from_file_location('terminal_screen',os.path.join(base,'terminal-screen.py'));screen_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(screen_module)
 for cols,rows in [(79,20),(80,24),(109,24),(110,30),(150,45)]:
  assert k.ResizePseudoConsole(pc,COORD(cols,rows))==0;time.sleep(.8)
  screen=screen_module.Screen(cols,rows);screen.feed(output());snapshot=screen.text()
  assert 'KEPOS' in snapshot.replace(' ',''),'Missing desk after resize'
  open(os.path.join(base,f'terminal-{cols}x{rows}.txt'),'w',encoding='utf8').write(snapshot)
 time.sleep(.3)
 # Actual model selector, member creation/deletion, and project creation dialogs.
 start=len(output());write('\x1bOS');wait_for('更换主 Agent 模型',8,start);write('\r');time.sleep(.6)
 start=len(output());write('\x1bOQ');wait_for('操作菜单',8,start);write('\x1b[B'*2+'\r');time.sleep(.3)
 write('Native Config Test\r');time.sleep(.4);write('\r');time.sleep(.4);write('\r');time.sleep(.6)
 config_path=os.path.join(os.environ['ORBITAL_HOME'],'workspace.json');config=workspace_config()
 assert any(a['name']=='Native Config Test' and a['model'] and a['provider'] for a in config['agents']),'Native member configuration dialog failed'
 start=len(output());write('\x1bOQ');wait_for('操作菜单',8,start);write('\x1b[B'*3+'\r');time.sleep(.3);write('\x1b[B'*2+'\r');time.sleep(.3);write('\x1b[B\r');time.sleep(.3);write('\r');time.sleep(.6)
 config=workspace_config();assert not any(a['name']=='Native Config Test' for a in config['agents']),'Member delete confirmation failed'
 project_c=os.path.join(workspace,'project-c');os.makedirs(project_c)
 start=len(output());write('\x1bOQ');wait_for('操作菜单',8,start);write('\r');time.sleep(.3);write(project_c+'\r');time.sleep(.3);write('\x1b[B\r');time.sleep(.6)
 config=workspace_config();assert project_c in config['projects'],'Native project creation dialog failed'
 # Submit /reload inside the desk; it must really reload without a model message.
 before_reload=open(session_file,encoding='utf8').read();start=len(output());write('/reload\r');wait_for('扩展已重载',20,start);wait_for('输入区',20,start);time.sleep(.5)
 assert '/reload' not in open(session_file,encoding='utf8').read(),'Reload was incorrectly sent as chat'
 # Native settings are handed off explicitly, rather than silently sent to the model.
 start=len(output());write('/settings\r');wait_for('操作菜单',10,start);write('\x1b');time.sleep(.4)
 time.sleep(.3);screen=screen_module.Screen(150,45);screen.feed(output());open(os.path.join(base,'terminal-150x45.txt'),'w',encoding='utf8').write(screen.text())
 # Verify mirror content, not just that an index exists. Pi remains canonical.
 with sqlite3.connect(os.path.join(workspace,'orbital.sqlite')) as connection:
  metas=[json.loads(row[0]) for row in connection.execute('SELECT meta FROM sessions')]
 for meta in metas:
  original=meta.get('piSessionFile')
  if not original or not os.path.isfile(original):continue
  expected=[]
  for line in open(original,encoding='utf8'):
   row=json.loads(line)
   if row.get('type')=='message' and row.get('message',{}).get('role') in ['user','assistant','toolResult']:expected.append(row)
  with sqlite3.connect(os.path.join(workspace,'orbital.sqlite')) as connection:
   mirrored=[json.loads(row[0]) for row in connection.execute('SELECT record FROM messages WHERE session_id=? ORDER BY seq',(meta['logicalSessionId'],))]
  mirrored=[m for m in mirrored if m['role'] in ['user','assistant','toolResult']]
  assert len(mirrored)==len(expected),'Mirror count mismatch: '+meta['title']
  assert len({m['messageUid'] for m in mirrored})==len(mirrored),'Duplicate mirror UID'
  for mirror,source in zip(mirrored,expected):assert mirror['content']==source['message']['content'],'Mirror content mismatch'
 print('PASS SessionStore mirror: real persisted user/assistant/tool messages match Pi records with unique stable UIDs')
 print('PASS real ConPTY:  startup, native desk, main model round-trip, persisted assistant response, help, focus, exit/reopen history, cross-project switch, parallel supervisor delegation and final summary, task screen, mouse help, F2 new conversation, background child survives project switch without cross-session injection, dynamic terminal resize, model selector, native member add/delete, native project add, in-desk reload/native handoff, unknown-command rejection, real Skill execution, real Unicode clipboard copy')
 print('Workspace:',workspace)
 json.dump({'pass':True,'workspace':workspace,'session':session_file,'token':token},open(os.path.join(base,'conpty-result.json'),'w',encoding='utf8'),ensure_ascii=False,indent=2)
finally:
 open(os.path.join(base,'conpty-sdk-output.ansi' if '--sdk' in sys.argv else 'conpty-smoke-output.ansi' if '--smoke' in sys.argv else 'conpty-output.ansi'),'wb').write(b''.join(chunks))
 k.TerminateProcess(pi.hProcess,0)
 k.CloseHandle(pi.hThread);k.CloseHandle(pi.hProcess);k.CloseHandle(wi)
 k.ClosePseudoConsole(pc);k.CloseHandle(ro)

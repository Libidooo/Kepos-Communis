import subprocess,time,sys
cmd=int(sys.argv[1]);ps1=sys.argv[2]
def kids():
 out=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',ps1,str(cmd)],capture_output=True,encoding='utf8',errors='replace')
 return [int(x) for x in out.stdout.split() if x.strip().isdigit()]
until=time.time()+10
while time.time()<until and kids():time.sleep(.4)
survivors=kids()
assert not survivors,'关窗后仍有残留 node 进程: '+str(survivors)
print('PASS close-window leaves no node processes')

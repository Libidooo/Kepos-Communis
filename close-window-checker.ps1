param([int]$cmd)
$ws=(Get-CimInstance Win32_Process -Filter "ParentProcessId=$cmd") | Where-Object {$_.Name -eq 'node.exe'} | Select-Object -First 1 -ExpandProperty ProcessId
$pids=@()
if($ws){$pids+=$ws;(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ws") | Where-Object {$_.Name -eq 'node.exe'} | ForEach-Object {$pids+=$_.ProcessId}}
$pids -join ' '

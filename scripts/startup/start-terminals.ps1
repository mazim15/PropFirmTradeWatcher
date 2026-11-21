# Waits for the network, settles, then opens each terminal shortcut in this folder one at a time,
# so FX Blue senders don't hit "symbol synchronization timeout" after a power cut.
# Never blocks forever: after -MaxWaitSec without a ping reply it starts the terminals anyway.
param(
  [switch]$DryRun,
  [string]$PingHost = '1.1.1.1',
  [int]$MaxWaitSec = 600,
  [int]$SettleSec = 60,
  [int]$GapSec = 20
)

$dir = $PSScriptRoot
$logFile = Join-Path $dir 'startup.log'
function Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Log ("start (dryRun={0}, host={1}, maxWait={2}s)" -f [bool]$DryRun, $PingHost, $MaxWaitSec)

$ping = New-Object System.Net.NetworkInformation.Ping
$deadline = (Get-Date).AddSeconds($MaxWaitSec)
$up = $false
while ((Get-Date) -lt $deadline) {
  try { if ($ping.Send($PingHost, 2000).Status -eq 'Success') { $up = $true; break } } catch { }
  Start-Sleep -Seconds 5
}
if ($up) { Log 'network up' } else { Log ("network not up after {0}s, starting anyway" -f $MaxWaitSec) }

if (-not $DryRun) { Start-Sleep -Seconds $SettleSec }

$links = @(Get-ChildItem -Path $dir -Filter '*.lnk' | Sort-Object Name)
for ($i = 0; $i -lt $links.Count; $i++) {
  if ($i -gt 0 -and -not $DryRun) { Start-Sleep -Seconds $GapSec }
  $lnk = $links[$i]
  if ($DryRun) { Log ("would start {0}" -f $lnk.Name); continue }
  try { Start-Process -FilePath $lnk.FullName; Log ("started {0}" -f $lnk.Name) }
  catch { Log ("failed {0}: {1}" -f $lnk.Name, $_.Exception.Message) }
}
Log ("done ({0} shortcuts)" -f $links.Count)

# Waits for the network, settles, then opens each terminal shortcut in this folder one at a time,
# so FX Blue senders don't hit "symbol synchronization timeout" after a power cut.
# Afterwards it moves any terminal shortcut found in shell:startup in here, so a new terminal is
# delayed from the next sign-in on. -MoveOnly does just that move (used by install-startup-delay.ps1).
# Never blocks forever: after -MaxWaitSec without a ping reply it starts the terminals anyway.
param(
  [switch]$DryRun,
  [switch]$MoveOnly,
  [string]$StartupDir = [Environment]::GetFolderPath('Startup'),
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

# Only shortcuts whose target is terminal.exe / terminal64.exe move; the watcher shortcut stays.
# A same-named shortcut to a different terminal gets a number, so neither is lost.
function Move-TerminalShortcuts {
  $shell = New-Object -ComObject WScript.Shell
  $movedFile = Join-Path $dir 'moved.txt'
  $moved = 0
  foreach ($lnk in @(Get-ChildItem -LiteralPath $StartupDir -Filter '*.lnk')) {
    try {
      $s = $shell.CreateShortcut($lnk.FullName)
      if ($s.TargetPath -notmatch '\\terminal(64)?\.exe$') { continue }
      $name = $lnk.Name
      for ($n = 2; Test-Path -LiteralPath (Join-Path $dir $name); $n++) {
        $old = $shell.CreateShortcut((Join-Path $dir $name))
        if ($old.TargetPath -eq $s.TargetPath -and $old.Arguments -eq $s.Arguments) { break }
        $name = '{0} ({1}).lnk' -f $lnk.BaseName, $n
      }
      Move-Item -LiteralPath $lnk.FullName -Destination (Join-Path $dir $name) -Force -ErrorAction Stop
      if (-not ((Test-Path $movedFile) -and (@(Get-Content $movedFile) -contains $name))) {
        Add-Content -Path $movedFile -Value $name -ErrorAction Stop
      }
      Log ("moved {0} from Startup" -f $name)
      $moved++
    } catch { Log ("could not move {0}: {1}" -f $lnk.Name, $_.Exception.Message) }
  }
  Write-Output "$moved moved"
}

if ($MoveOnly) { Move-TerminalShortcuts; return }

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

# Last, so Windows has already opened anything that was still in Startup.
if (-not $DryRun) { Move-TerminalShortcuts | Out-Null }

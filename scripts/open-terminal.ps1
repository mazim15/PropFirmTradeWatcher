# Start the one terminal at -Path (chosen by the watcher from its own inventory, never by the server)
# and wait until its log shows -Login logged in. Never starts an exe that is already running.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File open-terminal.ps1
#          -Path <exe> -Login <digits> -OutFile <path> [-DryRun]
# Writes { ok, step, error } as UTF-8 JSON and exits 0.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Login,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [switch]$DryRun,
  [int]$WaitSec = 75
)

$ErrorActionPreference = 'Stop'
$res = [ordered]@{ ok = $false; step = $null; error = $null }
$step = 'find'

function Read-Shared($p) {
  $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite, Delete')
  try { (New-Object IO.StreamReader($fs, [Text.Encoding]::Default, $true)).ReadToEnd() } finally { $fs.Dispose() }
}

# The last word on this login in these log lines: 'ok', 'failed: <text>', or $null.
function Login-Outcome($lines, $login) {
  $out = $null
  foreach ($l in $lines) {
    if ($l -notmatch "'$login': (.+)$") { continue }
    $msg = $Matches[1].Trim()
    if ($msg -match '^(authorization|login)\b.*(failed|invalid)|^invalid account') { $out = "failed: $msg" }
    elseif ($msg -match '^(authorized on |login on )') { $out = 'ok' }
  }
  $out
}

function Data-Folder($installDir) {
  foreach ($d in @(Get-ChildItem (Join-Path $env:APPDATA 'MetaQuotes\Terminal') -Directory -ErrorAction SilentlyContinue)) {
    $o = Join-Path $d.FullName 'origin.txt'
    if ((Test-Path -LiteralPath $o) -and ((Get-Content -LiteralPath $o -Raw).Trim().TrimEnd('\') -ieq $installDir.TrimEnd('\'))) { return $d.FullName }
  }
  $installDir
}

# "<log name>" -> how much of it existed before the start, so only new lines count (also past midnight).
function Log-Lengths($dir) {
  $h = @{}
  foreach ($f in @(Get-ChildItem $dir -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}\.log$' } |
      Sort-Object Name -Descending | Select-Object -First 2)) { $h[$f.Name] = (Read-Shared $f.FullName).Length }
  $h
}
function New-Lines($dir, $before) {
  $lines = @()
  foreach ($f in @(Get-ChildItem $dir -Filter '*.log' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}\.log$' } |
      Sort-Object Name -Descending | Select-Object -First 2 | Sort-Object Name)) {
    $t = Read-Shared $f.FullName
    $from = if ($before.ContainsKey($f.Name)) { [Math]::Min($before[$f.Name], $t.Length) } else { 0 }
    $lines += $t.Substring($from) -split "`r?`n"
  }
  , $lines
}

try {
  if ($Login -notmatch '^\d+$') { throw 'bad -Login' }
  if ($Path -notmatch '\\terminal(64)?\.exe$' -or !(Test-Path -LiteralPath $Path)) { throw 'terminal not found' }
  $installDir = Split-Path $Path -Parent
  $logDir = Join-Path (Data-Folder $installDir) 'logs'

  $step = 'start'
  $already = @(Get-Process terminal, terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $Path }).Count -gt 0
  if ($already -or $DryRun) { $res.ok = $true; if ($DryRun) { $res.step = "would start $Path" }; return }
  $before = Log-Lengths $logDir
  Start-Process -FilePath $Path -WorkingDirectory $installDir

  $step = 'login'
  $deadline = (Get-Date).AddSeconds($WaitSec); $outcome = $null
  # Other failures (no connection) are retried by the terminal, so keep waiting on those.
  do {
    Start-Sleep -Seconds 2
    $outcome = Login-Outcome (New-Lines $logDir $before) $Login
  } while ($outcome -ne 'ok' -and $outcome -notmatch '(?i)^failed:.*invalid (account|password)' -and (Get-Date) -lt $deadline)
  if ($outcome -eq 'ok') { $res.ok = $true }
  elseif ($outcome) { throw ($outcome -replace '^failed: ', '') }
  else { throw 'Opened, but no login was confirmed' }
} catch {
  $res.step = $step
  $res.error = $_.Exception.Message
} finally {
  [IO.File]::WriteAllText($OutFile, ($res | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
}
exit 0

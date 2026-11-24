# Installed MT4/MT5 terminals on this PC, and which are running (read-only; opens no window).
#
# A running terminal's login comes from its window title and is remembered in
# %LOCALAPPDATA%\copier\terminal-logins.json. A closed one's login: MT5 from config\common.ini, else
# the remembered one; MT4 (which keeps no readable login) the remembered one, else its newest logs.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File terminal-inventory.ps1 -OutFile <path>
# Writes { terminals: [{ kind, path, login, running, lastUsed }] } as UTF-8 JSON and exits 0; a running terminal whose path
# can't be read (started as administrator) fails the run, since it would look closed.
param([Parameter(Mandatory = $true)][string]$OutFile)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class TermWin { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max); }
"@
function T($h) { $sb = New-Object System.Text.StringBuilder 512; [void][TermWin]::GetWindowText($h, $sb, 512); $sb.ToString() }

# Terminals keep their log open, so share it. Encoding by BOM (MT5 is UTF-16, MT4 plain).
function Read-Shared($path) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  try { (New-Object IO.StreamReader($fs, [Text.Encoding]::Default, $true)).ReadToEnd() } finally { $fs.Dispose() }
}
function Logs($dataDir, $n) {
  @(Get-ChildItem (Join-Path $dataDir 'logs') -Filter '*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{8}\.log$' } | Sort-Object Name -Descending | Select-Object -First $n)
}
function Closed-Login($kind, $dataDir, $remembered) {
  if ($kind -eq 'mt5') {
    $ini = Join-Path $dataDir 'config\common.ini'
    if (Test-Path -LiteralPath $ini) {
      $m = [regex]::Match((Read-Shared $ini), '(?m)^Login=(\d+)')
      if ($m.Success) { return $m.Groups[1].Value }
    }
    return $remembered
  }
  if ($remembered) { return $remembered }
  foreach ($log in (Logs $dataDir 5)) {
    $m = [regex]::Matches((Read-Shared $log.FullName), "'(\d+)': login on ")
    if ($m.Count) { return $m[$m.Count - 1].Groups[1].Value }
  }
  ''
}

$store = Join-Path $env:LOCALAPPDATA 'copier\terminal-logins.json'
$known = @{}
try { (Get-Content -LiteralPath $store -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $known[$_.Name] = [string]$_.Value } } catch { }
$changed = $false

# exe path (lower case) -> main window handle
$running = @{}
foreach ($p in @(Get-Process terminal, terminal64 -ErrorAction SilentlyContinue)) {
  if (!$p.Path) { throw "can't read the path of $($p.ProcessName) $($p.Id)" }  # it would look closed
  $k = $p.Path.ToLower()
  if (!$running.ContainsKey($k) -or $running[$k] -eq [IntPtr]::Zero) { $running[$k] = $p.MainWindowHandle }
}

$dirs = New-Object System.Collections.Generic.List[object]
foreach ($d in @(Get-ChildItem (Join-Path $env:APPDATA 'MetaQuotes\Terminal') -Directory -ErrorAction SilentlyContinue)) {
  $o = Join-Path $d.FullName 'origin.txt'
  if (!(Test-Path -LiteralPath $o)) { continue }
  $dirs.Add(@{ install = (Get-Content -LiteralPath $o -Raw).Trim().TrimEnd('\'); data = $d.FullName })
}
foreach ($k in $running.Keys) {  # portable: data lives in the install folder
  $dir = Split-Path $k -Parent
  if (!(@($dirs | Where-Object { $_.install -ieq $dir }).Count)) { $dirs.Add(@{ install = $dir; data = $dir }) }
}

$terminals = New-Object System.Collections.Generic.List[object]
foreach ($d in $dirs) {
  foreach ($e in @(@('mt5', 'terminal64.exe'), @('mt4', 'terminal.exe'))) {
    try {
      $exe = Join-Path $d.install $e[1]
      if (!(Test-Path -LiteralPath $exe)) { continue }
      $key = $exe.ToLower()
      $isRunning = $running.ContainsKey($key)
      $login = ''
      if ($isRunning) {
        $login = [regex]::Match((T $running[$key]), '^\s*(\d+)').Groups[1].Value
        if ($login -and $known[$key] -ne $login) { $known[$key] = $login; $changed = $true }
      }
      if (!$login) { $login = [string](Closed-Login $e[0] $d.data ([string]$known[$key])) }
      $last = Logs $d.data 1
      $used = if ($last.Count) { $last[0].LastWriteTimeUtc.ToString('o') } else { '' }
      $terminals.Add([ordered]@{ kind = $e[0]; path = $exe; login = $login; running = $isRunning; lastUsed = $used })
    } catch { }  # one bad folder never hides the others
  }
}

if ($changed) {
  try {
    New-Item -ItemType Directory -Force (Split-Path $store -Parent) | Out-Null
    [IO.File]::WriteAllText($store, ($known | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
  } catch { }
}
$json = [ordered]@{ terminals = $terminals.ToArray() } | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
exit 0

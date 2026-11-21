# Copier settings scan (read-only).
#
# For every running MT4 (terminal.exe) and MT5 (terminal64.exe) terminal, opens each EA's
# properties dialog, saves TradeCopy settings to a temp .set file, and cancels. It never
# presses OK, Load or Remove. Only dialogs this run opened are touched; dialogs that were
# already open are left alone. Controls are addressed by ID or name only.
#
# Each sender's clean read is kept as %LOCALAPPDATA%\copier\sets\<login>-sender.set (overwritten
# every scan), so a sender that later goes missing can be re-attached with its last good settings.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File copier-scan.ps1 -OutFile <path>
# Writes { scannedAt, terminals: [{ kind, path, dataFolder, login, error, eas: [{ title, set }] }] }
# as UTF-8 JSON and exits 0, even when individual terminals fail.
param([Parameter(Mandatory = $true)][string]$OutFile)

$ErrorActionPreference = 'Stop'
$scanDir = Join-Path $env:TEMP 'copier-scan'
New-Item -ItemType Directory -Force $scanDir | Out-Null
$keepDir = Join-Path $env:LOCALAPPDATA 'copier\sets'
New-Item -ItemType Directory -Force $keepDir | Out-Null
$keepLogin = ''  # login of the terminal being scanned; set per terminal below
$terminals = New-Object System.Collections.Generic.List[object]
$scannedAt = (Get-Date).ToUniversalTime().ToString('o')

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CopierWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$W = [CopierWin]
$Z = [IntPtr]::Zero
# Every dialog this run opened, so the final cleanup can cancel any still open.
$opened = New-Object System.Collections.Generic.List[IntPtr]

function T($h) { $sb = New-Object System.Text.StringBuilder 512; [void]$W::GetWindowText($h, $sb, 512); $sb.ToString() }

function Dialogs($procId) {
  $list = @(); $h = $Z
  while (($h = $W::FindWindowEx($Z, $h, '#32770', [NullString]::Value)) -ne $Z) {
    $wp = 0; [void]$W::GetWindowThreadProcessId($h, [ref]$wp)
    if ($wp -eq $procId -and $W::IsWindowVisible($h)) { $list += $h }
  }
  , $list
}

# A visible dialog of this process that was not in $before, polled up to $timeoutSec.
function New-Dialog($procId, $before, $timeoutSec, $pattern = '*') {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    foreach ($h in (Dialogs $procId)) {
      if ($before -notcontains $h -and (T $h) -like $pattern) { $opened.Add($h); return $h }
    }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  $Z
}

function Click($h) { if ($h -ne $Z) { [void]$W::PostMessage($h, 0x00F5, $Z, $Z) } }  # BM_CLICK

function ByName($dlgH, $name) {
  $e = $A::FromHandle($dlgH).FindFirst('Descendants', (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)))
  if ($e) { [IntPtr]$e.Current.NativeWindowHandle } else { $Z }
}

function Cancel-Dialog($h) {
  if ($h -eq $Z -or -not $W::IsWindow($h)) { return }
  $b = $W::GetDlgItem($h, 2); if ($b -eq $Z) { $b = ByName $h 'Cancel' }
  Click $b
  $t0 = Get-Date; while ($W::IsWindow($h) -and ((Get-Date) - $t0).TotalSeconds -lt 3) { Start-Sleep -Milliseconds 100 }
}

function Fill-FileDialog($dlgH, $path) {
  $deadline = (Get-Date).AddSeconds(5); $target = $null
  do {
    $edits = @($A::FromHandle($dlgH).FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Edit'))))
    $target = $edits | Where-Object { $_.Current.AutomationId -in '1148', '1001', '1152' } | Select-Object -First 1
    if (!$target) { Start-Sleep -Milliseconds 300 }
  } while (!$target -and (Get-Date) -lt $deadline)
  if (!$target) { return $false }
  [void]$W::SendMessage([IntPtr]$target.Current.NativeWindowHandle, 0x000C, $Z, $path)  # WM_SETTEXT
  Click ($W::GetDlgItem($dlgH, 1))
  $true
}

# With a properties dialog open: TradeCopy -> Save its settings and return the text;
# anything else -> $null. Always cancels the dialog. Throws on a failed save.
function Read-Properties($procId, $props, $tag) {
  $title = T $props
  try {
    if ($title -notmatch 'TradeCopy') { return @{ title = $title; set = $null } }
    $saveBtn = ByName $props 'Save'
    if ($saveBtn -eq $Z) { $saveBtn = $W::GetDlgItem($props, 4014) }
    if ($saveBtn -eq $Z) { throw "'$title': Save button not found" }
    $file = Join-Path $scanDir ("$tag-" + [guid]::NewGuid().ToString('N') + '.set')
    $before = Dialogs $procId
    Click $saveBtn
    $save = New-Dialog $procId $before 5
    if ($save -eq $Z) { throw "'$title': Save dialog did not open" }
    if (!(Fill-FileDialog $save $file)) { Cancel-Dialog $save; throw "'$title': file name box not found" }
    $t0 = Get-Date; while (!(Test-Path $file) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 200 }
    if ($W::IsWindow($save)) { Cancel-Dialog $save }
    if (!(Test-Path $file)) { throw "'$title': settings file was not saved" }
    $text = [IO.File]::ReadAllText($file)
    if ($title -match 'TradeCopy Sender' -and $script:keepLogin) {
      # Keeping a copy must never fail the scan.
      try { Move-Item $file (Join-Path $keepDir "$($script:keepLogin)-sender.set") -Force } catch { Remove-Item $file -Force -ErrorAction SilentlyContinue }
    } else {
      Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
    return @{ title = $title; set = $text }
  } finally {
    Cancel-Dialog $props
  }
}

function Data-Folder($installDir) {
  $root = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
  if (Test-Path $root) {
    foreach ($d in Get-ChildItem $root -Directory) {
      $o = Join-Path $d.FullName 'origin.txt'
      if ((Test-Path $o) -and ((Get-Content $o -Raw).Trim().TrimEnd('\') -ieq $installDir.TrimEnd('\'))) { return $d.Name }
    }
  }
  $installDir  # portable mode: data lives in the install folder
}

function Scan-MT4($p, $eas) {
  $main = $p.MainWindowHandle
  $mdi = $W::FindWindowEx($main, $Z, 'MDIClient', [NullString]::Value)
  if ($mdi -eq $Z) { throw 'MDIClient not found' }
  $active = $W::SendMessage($mdi, 0x0229, $Z, $Z)  # WM_MDIGETACTIVE, restored at the end
  $frames = @(); $c = $Z
  while (($c = $W::FindWindowEx($mdi, $c, [NullString]::Value, [NullString]::Value)) -ne $Z) { $frames += $c }
  try {
    $n = 0
    foreach ($f in $frames) {
      $n++
      [void]$W::SendMessage($mdi, 0x0222, $f, $Z)  # WM_MDIACTIVATE
      Start-Sleep -Milliseconds 400
      $before = Dialogs $p.Id
      [void]$W::PostMessage($f, 0x0100, [IntPtr]0x76, [IntPtr]0x00410001)  # F7 down
      [void]$W::PostMessage($f, 0x0101, [IntPtr]0x76, [IntPtr]0xC0410001)  # F7 up
      $props = New-Dialog $p.Id $before 3 'Expert*'
      if ($props -eq $Z) { continue }  # chart without an EA
      $eas.Add((Read-Properties $p.Id $props "mt4-$n"))
    }
  } finally {
    if ($active -ne $Z -and $W::IsWindow($active)) { [void]$W::SendMessage($mdi, 0x0222, $active, $Z) }
  }
}

function Scan-MT5($p, $eas) {
  $before = Dialogs $p.Id
  [void]$W::PostMessage($p.MainWindowHandle, 0x0111, [IntPtr]33015, $Z)  # Charts -> Expert List
  $list = New-Dialog $p.Id $before 3 'Experts'
  if ($list -eq $Z) { throw 'Expert List did not open' }
  try {
    $lv = $W::GetDlgItem($list, 10309)
    $count = [int]$W::SendMessage($lv, 0x1004, $Z, $Z)  # LVM_GETITEMCOUNT
    for ($i = 0; $i -lt $count; $i++) {
      [void]$W::PostMessage($lv, 0x0100, [IntPtr]0x24, [IntPtr]0x01470001)  # VK_HOME
      for ($k = 0; $k -lt $i; $k++) { [void]$W::PostMessage($lv, 0x0100, [IntPtr]0x28, [IntPtr]0x01500001) }  # VK_DOWN
      Start-Sleep -Milliseconds 300
      $before = Dialogs $p.Id
      Click ($W::GetDlgItem($list, 10001))  # Properties
      $props = New-Dialog $p.Id $before 3
      if ($props -eq $Z) { throw "Expert List row ${i}: properties did not open" }
      $eas.Add((Read-Properties $p.Id $props "mt5-$i"))
    }
  } finally {
    Cancel-Dialog $list
  }
}

try {
  $procs = @(Get-Process terminal, terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne $Z })
  foreach ($p in $procs) {
    $kind = if ($p.ProcessName -eq 'terminal64') { 'mt5' } else { 'mt4' }
    $eas = New-Object System.Collections.Generic.List[object]
    $err = $null; $installDir = ''; $dataFolder = ''; $login = ''
    try {
      $installDir = Split-Path $p.Path -Parent
      $dataFolder = Data-Folder $installDir
      $login = [regex]::Match((T $p.MainWindowHandle), '^\s*(\d+)').Groups[1].Value
      $script:keepLogin = $login
      if ($kind -eq 'mt4') { Scan-MT4 $p $eas } else { Scan-MT5 $p $eas }
    } catch {
      $err = $_.Exception.Message
    } finally {
      foreach ($h in $opened) { Cancel-Dialog $h }
      $opened.Clear()
    }
    $terminals.Add([ordered]@{ kind = $kind; path = $installDir; dataFolder = $dataFolder; login = $login; error = $err; eas = $eas })
  }
} catch {
  $terminals.Add([ordered]@{ kind = 'mt4'; path = ''; dataFolder = ''; login = ''; error = "scan failed: $($_.Exception.Message)"; eas = @() })
} finally {
  foreach ($h in $opened) { Cancel-Dialog $h }
  $json = [ordered]@{ scannedAt = $scannedAt; terminals = $terminals } | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
}
exit 0

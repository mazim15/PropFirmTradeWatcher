# Change one FX Blue receiver's fixed lot, with read-back.
#
# Finds the MT4 chart whose TradeCopy Receiver has -Channel, saves its settings, loads a copy
# with only UseFixedLotSize changed, presses OK, reopens and saves again to confirm, then patches
# the matching profiles\default\chart*.chr so the lot survives a restart. The only dialog it
# presses OK on is that receiver's properties, and only after Load succeeded. Every other
# dialog this run opened is cancelled, on every path. Controls are addressed by ID or name.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File copier-set-lot.ps1 -Channel <name> -Lot <0.01-10> -OutFile <path>
# Writes { ok, oldLot, newLot, chartFile, step, error } as UTF-8 JSON and exits 0.
param(
  [Parameter(Mandatory = $true)][string]$Channel,
  [Parameter(Mandatory = $true)][string]$Lot,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
$workDir = Join-Path $env:TEMP 'copier-set-lot'
New-Item -ItemType Directory -Force $workDir | Out-Null
$inv = [Globalization.CultureInfo]::InvariantCulture
$res = [ordered]@{ ok = $false; oldLot = $null; newLot = $null; chartFile = $null; step = $null; error = $null }
$step = 'find'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CopierSetWin {
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
$W = [CopierSetWin]
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

function Open-Props($p, $mdi, $f) {
  [void]$W::SendMessage($mdi, 0x0222, $f, $Z)  # WM_MDIACTIVATE
  Start-Sleep -Milliseconds 400
  $before = Dialogs $p.Id
  [void]$W::PostMessage($f, 0x0100, [IntPtr]0x76, [IntPtr]0x00410001)  # F7 down
  [void]$W::PostMessage($f, 0x0101, [IntPtr]0x76, [IntPtr]0xC0410001)  # F7 up
  New-Dialog $p.Id $before 3 'Expert*'
}

# Properties -> Save -> file; returns the settings text. Throws on failure.
function Save-Settings($p, $props, $file) {
  $btn = ByName $props 'Save'; if ($btn -eq $Z) { $btn = $W::GetDlgItem($props, 4014) }
  if ($btn -eq $Z) { throw 'Save button not found' }
  $before = Dialogs $p.Id; Click $btn
  $d = New-Dialog $p.Id $before 5; if ($d -eq $Z) { throw 'Save dialog did not open' }
  if (!(Fill-FileDialog $d $file)) { Cancel-Dialog $d; throw 'Save file name box not found' }
  $t0 = Get-Date; while (!(Test-Path $file) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 200 }
  if ($W::IsWindow($d)) { Cancel-Dialog $d }
  if (!(Test-Path $file)) { throw 'settings file was not saved' }
  [IO.File]::ReadAllText($file)
}

function Val($t, $k) { [regex]::Match($t, "(?m)^$k=([^\r\n|]*)").Groups[1].Value }
function Num($s) { $d = 0.0; if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, $inv, [ref]$d)) { $d } else { $null } }
function Enc($path) { if ([IO.File]::ReadAllBytes($path)[0] -eq 0xFF) { [Text.Encoding]::Unicode } else { [Text.Encoding]::Default } }
function Set-Lot($text) { [regex]::Replace($text, '(?m)^UseFixedLotSize=[^\r\n]*', "UseFixedLotSize=$Lot") }

function Data-Folder($installDir) {
  $root = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
  if (Test-Path $root) {
    foreach ($d in Get-ChildItem $root -Directory) {
      $o = Join-Path $d.FullName 'origin.txt'
      if ((Test-Path $o) -and ((Get-Content $o -Raw).Trim().TrimEnd('\') -ieq $installDir.TrimEnd('\'))) { return $d.FullName }
    }
  }
  $installDir  # portable mode: data lives in the install folder
}

$props = $Z; $mdi = $Z; $active = $Z
try {
  $want = Num $Lot
  if ($Lot -notmatch '^\d+(\.\d{1,2})?$' -or $want -lt 0.01 -or $want -gt 10) { throw "bad lot '$Lot'" }
  $stamp = [guid]::NewGuid().ToString('N')

  # 1. find: the MT4 chart whose receiver has this channel; its properties stay open.
  $p = $null; $target = $Z
  foreach ($proc in @(Get-Process terminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne $Z })) {
    $m = $W::FindWindowEx($proc.MainWindowHandle, $Z, 'MDIClient', [NullString]::Value)
    if ($m -eq $Z) { continue }
    $act = $W::SendMessage($m, 0x0229, $Z, $Z)  # WM_MDIGETACTIVE
    $frames = @(); $c = $Z
    while (($c = $W::FindWindowEx($m, $c, [NullString]::Value, [NullString]::Value)) -ne $Z) { $frames += $c }
    foreach ($f in $frames) {
      $h = Open-Props $proc $m $f
      if ($h -eq $Z) { continue }
      if ((T $h) -notmatch 'TradeCopy Receiver') { Cancel-Dialog $h; continue }
      $t = Save-Settings $proc $h (Join-Path $workDir "$stamp-find.set")
      Remove-Item (Join-Path $workDir "$stamp-find.set") -Force -ErrorAction SilentlyContinue
      if ((Val $t 'Channel') -eq $Channel) { $p = $proc; $mdi = $m; $active = $act; $target = $f; $props = $h; break }
      Cancel-Dialog $h
    }
    if ($target -ne $Z) { break }
    if ($act -ne $Z -and $W::IsWindow($act)) { [void]$W::SendMessage($m, 0x0222, $act, $Z) }
  }
  if ($target -eq $Z) { throw "no receiver with channel $Channel" }

  # 2. save-before: current settings, then a copy with only the lot changed.
  $step = 'save-before'
  $beforeFile = Join-Path $workDir "$stamp-before.set"; $afterFile = Join-Path $workDir "$stamp-after.set"
  $t = Save-Settings $p $props $beforeFile
  $res.oldLot = Num (Val $t 'UseFixedLotSize')
  [IO.File]::WriteAllText($afterFile, (Set-Lot $t), (Enc $beforeFile))

  # 3. load: Load -> Open dialog -> the edited file.
  $step = 'load'
  $loadBtn = ByName $props 'Load'; if ($loadBtn -eq $Z) { throw 'Load button not found' }
  $before = Dialogs $p.Id; Click $loadBtn
  $d = New-Dialog $p.Id $before 5; if ($d -eq $Z) { throw 'Open dialog did not open' }
  if (!(Fill-FileDialog $d $afterFile)) { Cancel-Dialog $d; throw 'Open file name box not found' }
  $t0 = Get-Date; while ($W::IsWindow($d) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 100 }
  if ($W::IsWindow($d)) { throw 'Open dialog did not close' }
  Start-Sleep -Milliseconds 800

  # 4. ok: the one OK press of this run.
  $step = 'ok'
  Click ($W::GetDlgItem($props, 1))
  $t0 = Get-Date; while ($W::IsWindow($props) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 100 }
  if ($W::IsWindow($props)) { throw 'properties did not close after OK' }
  $props = $Z
  Start-Sleep 2

  # 5. read-back: reopen, save, compare.
  $step = 'read-back'
  $props = Open-Props $p $mdi $target
  if ($props -eq $Z) { throw 'could not reopen properties' }
  $t2 = Save-Settings $p $props (Join-Path $workDir "$stamp-readback.set")
  Cancel-Dialog $props; $props = $Z
  $res.newLot = Num (Val $t2 'UseFixedLotSize')
  if ((Val $t2 'Channel') -ne $Channel -or $res.newLot -ne $want) { throw 'READ-BACK MISMATCH' }

  # 6. chart-file: persist so the lot survives a restart.
  $step = 'chart-file'
  $dir = Join-Path (Data-Folder (Split-Path $p.Path -Parent)) 'profiles\default'
  $chr = Get-ChildItem (Join-Path $dir 'chart*.chr') -ErrorAction SilentlyContinue |
    Where-Object { (Val ([IO.File]::ReadAllText($_.FullName)) 'Channel') -eq $Channel } | Select-Object -First 1
  if (!$chr) { throw "lot is live, but no chart file has channel $Channel (lost on restart)" }
  [IO.File]::WriteAllText($chr.FullName, (Set-Lot ([IO.File]::ReadAllText($chr.FullName))), (Enc $chr.FullName))
  $res.chartFile = $chr.Name

  $res.ok = $true
} catch {
  $res.step = $step
  $res.error = $_.Exception.Message
} finally {
  foreach ($h in $opened) { Cancel-Dialog $h }
  if ($mdi -ne $Z -and $active -ne $Z -and $W::IsWindow($active)) { [void]$W::SendMessage($mdi, 0x0222, $active, $Z) }
  Get-ChildItem $workDir -Filter '*.set' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($OutFile, ($res | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
}
exit 0

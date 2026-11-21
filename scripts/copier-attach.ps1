# Attach the trade exporter or the FX Blue TradeCopy Sender to an MT5 terminal, on a new chart.
#
# Opens a new XAUUSD chart (File -> New Chart -> ... -> XAUUSD, found by menu text), inserts the EA
# (Insert -> Experts -> ..., found by menu text), and for the sender loads settings with -Channel
# set: -BaseSet when given (the last good settings kept by the scan), else the EA's defaults.
# Presses OK, checks the Expert List grew by exactly one, then File -> Profiles -> Save. Always a
# new chart: one chart holds one EA, so attaching to an existing chart would replace it. On any
# failure every dialog this run opened is cancelled, and a chart it opened that got no EA is closed.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File copier-attach.ps1
#          -Login <digits> -Expert exporter|sender [-Channel <name>] [-BaseSet <path>] -OutFile <path>
# Writes { ok, step, error } as UTF-8 JSON and exits 0.
param(
  [Parameter(Mandatory = $true)][string]$Login,
  [Parameter(Mandatory = $true)][ValidateSet('exporter', 'sender')][string]$Expert,
  [string]$Channel,
  [string]$BaseSet,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
$workDir = Join-Path $env:TEMP 'copier-attach'
New-Item -ItemType Directory -Force $workDir | Out-Null
$res = [ordered]@{ ok = $false; step = $null; error = $null }
$step = 'find'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CopierAttachWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int pos);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr m, int pos);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint item, StringBuilder sb, int max, uint flags);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$W = [CopierAttachWin]
$Z = [IntPtr]::Zero
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

function Menu-Text($m, $i) {
  $sb = New-Object System.Text.StringBuilder 256; [void]$W::GetMenuString($m, [uint32]$i, $sb, 256, 0x400)
  ($sb.ToString() -replace '&', '') -replace "`t.*", ''
}
# The submenu at a text path ('File/New Chart'), or $Z.
function Sub-Menu($m, $path) {
  foreach ($part in ($path -split '/')) {
    $next = $Z
    for ($i = 0; $i -lt $W::GetMenuItemCount($m); $i++) { if ((Menu-Text $m $i) -eq $part) { $next = $W::GetSubMenu($m, $i); break } }
    if ($next -eq $Z) { return $Z }
    $m = $next
  }
  $m
}
# The ID of the first item anywhere under $m whose text is $text (depth-first), or $null.
function Find-Leaf($m, $text) {
  if ($m -eq $Z) { return $null }
  for ($i = 0; $i -lt $W::GetMenuItemCount($m); $i++) {
    $sub = $W::GetSubMenu($m, $i)
    if ($sub -ne $Z) { $r = Find-Leaf $sub $text; if ($null -ne $r) { return $r } }
    elseif ((Menu-Text $m $i) -eq $text) { return $W::GetMenuItemID($m, $i) }
  }
  $null
}

function Expert-Count($p) {
  $before = Dialogs $p.Id
  [void]$W::PostMessage($p.MainWindowHandle, 0x0111, [IntPtr]33015, $Z)  # Charts -> Expert List
  $l = New-Dialog $p.Id $before 3 'Experts'
  if ($l -eq $Z) { throw 'Expert List did not open' }
  $n = [int]$W::SendMessage($W::GetDlgItem($l, 10309), 0x1004, $Z, $Z)  # LVM_GETITEMCOUNT
  Cancel-Dialog $l
  $n
}

function Frames($mdi) { $l = @(); $c = $Z; while (($c = $W::FindWindowEx($mdi, $c, [NullString]::Value, [NullString]::Value)) -ne $Z) { $l += $c }; , $l }
function Enc($path) { if ([IO.File]::ReadAllBytes($path)[0] -eq 0xFF) { [Text.Encoding]::Unicode } else { [Text.Encoding]::Default } }

$props = $Z; $mdi = $Z; $newChart = $Z; $attached = $false
try {
  if ($Login -notmatch '^\d+$') { throw 'bad -Login' }
  if ($Expert -eq 'sender' -and $Channel -notmatch '^[A-Za-z0-9_-]{1,32}$') { throw 'sender needs a valid -Channel' }
  $stamp = [guid]::NewGuid().ToString('N')

  # 1. find: the terminal, its menu items, and how many EAs it runs now.
  $p = @(Get-Process terminal64 -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne $Z -and (T $_.MainWindowHandle) -match "^\s*$Login\b" }) | Select-Object -First 1
  if (!$p) { throw "no MT5 terminal for login $Login" }
  $main = $p.MainWindowHandle
  $menu = $W::GetMenu($main)
  $mdi = $W::FindWindowEx($main, $Z, 'MDIClient', [NullString]::Value)
  if ($mdi -eq $Z) { throw 'MDIClient not found' }
  $chartId = Find-Leaf (Sub-Menu $menu 'File/New Chart') 'XAUUSD'
  if ($null -eq $chartId) { throw 'File/New Chart/.../XAUUSD not found' }
  $eaName = if ($Expert -eq 'exporter') { 'MT5_TradeExporter' } else { 'FX Blue - TradeCopy Sender' }
  $eaId = Find-Leaf (Sub-Menu $menu 'Insert/Experts') $eaName
  if ($null -eq $eaId) { throw "Insert/Experts/.../$eaName not found" }
  $count0 = Expert-Count $p

  # 2. chart: a new XAUUSD chart, made active.
  $step = 'chart'
  $before = Frames $mdi
  [void]$W::PostMessage($main, 0x0111, [IntPtr][int]$chartId, $Z)
  $t0 = Get-Date
  do { Start-Sleep -Milliseconds 300; $newChart = @(Frames $mdi | Where-Object { $before -notcontains $_ }) | Select-Object -First 1 }
  while (!$newChart -and ((Get-Date) - $t0).TotalSeconds -lt 5)
  if (!$newChart) { $newChart = $Z; throw 'new chart did not open' }
  [void]$W::SendMessage($mdi, 0x0222, $newChart, $Z)  # WM_MDIACTIVATE
  Start-Sleep -Milliseconds 500

  # 3. insert: the EA's properties dialog on the new chart.
  $step = 'insert'
  $before = Dialogs $p.Id
  [void]$W::PostMessage($main, 0x0111, [IntPtr][int]$eaId, $Z)
  $props = New-Dialog $p.Id $before 5
  if ($props -eq $Z) { throw 'EA properties did not open' }
  $want = if ($Expert -eq 'exporter') { 'TradeExporter' } else { 'TradeCopy Sender' }
  if ((T $props) -notmatch $want) { throw "unexpected dialog '$(T $props)'" }

  # 4. sender only: load settings with the channel set.
  if ($Expert -eq 'sender') {
    $step = 'set-inputs'
    $saved = Join-Path $workDir "$stamp-defaults.set"; $loadFile = Join-Path $workDir "$stamp-load.set"
    $btn = ByName $props 'Save'; if ($btn -eq $Z) { $btn = $W::GetDlgItem($props, 4014) }
    if ($btn -eq $Z) { throw 'Save button not found' }
    $before = Dialogs $p.Id; Click $btn
    $d = New-Dialog $p.Id $before 5; if ($d -eq $Z) { throw 'Save dialog did not open' }
    if (!(Fill-FileDialog $d $saved)) { Cancel-Dialog $d; throw 'Save file name box not found' }
    $t0 = Get-Date; while (!(Test-Path $saved) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 200 }
    if ($W::IsWindow($d)) { Cancel-Dialog $d }
    if (!(Test-Path $saved)) { throw 'settings file was not saved' }
    $base = if ($BaseSet -and (Test-Path $BaseSet)) { $BaseSet } else { $saved }
    $text = [IO.File]::ReadAllText($base)
    if ($text -notmatch '(?m)^Channel=') { throw 'No input Channel' }
    $text = [regex]::Replace($text, '(?m)^(Channel=)[^\r\n|]*', { param($m) $m.Groups[1].Value + $Channel }.GetNewClosure())
    [IO.File]::WriteAllText($loadFile, $text, (Enc $base))

    $loadBtn = ByName $props 'Load'; if ($loadBtn -eq $Z) { throw 'Load button not found' }
    $before = Dialogs $p.Id; Click $loadBtn
    $d = New-Dialog $p.Id $before 5; if ($d -eq $Z) { throw 'Open dialog did not open' }
    if (!(Fill-FileDialog $d $loadFile)) { Cancel-Dialog $d; throw 'Open file name box not found' }
    $t0 = Get-Date; while ($W::IsWindow($d) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 100 }
    if ($W::IsWindow($d)) { throw 'Open dialog did not close' }
    Start-Sleep -Milliseconds 800
  }

  # 5. ok
  $step = 'ok'
  Click ($W::GetDlgItem($props, 1))
  $t0 = Get-Date; while ($W::IsWindow($props) -and ((Get-Date) - $t0).TotalSeconds -lt 5) { Start-Sleep -Milliseconds 100 }
  if ($W::IsWindow($props)) { throw 'properties did not close after OK' }
  $props = $Z; $attached = $true
  Start-Sleep 2

  # 6. verify: exactly one more EA.
  $step = 'verify'
  $count1 = Expert-Count $p
  if ($count1 -ne $count0 + 1) { throw "Expert List has $count1 EAs, expected $($count0 + 1)" }

  # 7. persist
  $step = 'persist'
  $saveId = Find-Leaf (Sub-Menu $menu 'File/Profiles') 'Save'
  if ($null -eq $saveId) { throw 'attached, but File/Profiles/Save was not found (lost on restart)' }
  [void]$W::PostMessage($main, 0x0111, [IntPtr][int]$saveId, $Z)
  Start-Sleep 2

  $res.ok = $true
} catch {
  $res.step = $step
  $res.error = $_.Exception.Message
} finally {
  foreach ($h in $opened) { Cancel-Dialog $h }
  # A chart this run opened that never got its EA is closed again.
  if (!$attached -and $newChart -ne $Z -and $W::IsWindow($newChart)) { [void]$W::SendMessage($mdi, 0x0221, $newChart, $Z) }  # WM_MDIDESTROY
  Get-ChildItem $workDir -Filter '*.set' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($OutFile, ($res | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
}
exit 0

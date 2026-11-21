# Attach the trade exporter or the FX Blue TradeCopy Sender to an MT5 terminal, on a new chart.
#
# Writes a chart template holding the EA as the terminal's Templates\default.tpl, which MT5 applies
# to every new chart, opens a new XAUUSD chart (File -> New Chart -> ... -> XAUUSD, found by menu
# text), and puts the previous default.tpl back at once. No dialog is involved: Insert -> Experts
# only lists the 5 most recently used EAs, and MT5's Save Template dialog ignores the typed name. The
# sender's inputs are -BaseSet when given (the last good settings kept by the scan), else the EA's
# defaults, with Channel set to -Channel. Checks the Expert List grew by exactly one, then
# File -> Profiles -> Save. Always a new chart: one chart holds one EA, so attaching to an existing
# chart would replace it. On any failure every dialog this run opened is cancelled, default.tpl is
# restored, and a chart it opened that got no EA is closed.
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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint flags);
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

# A minimized terminal ignores menu commands (the Expert List won't open), so show it without
# taking focus while this run works on it, and minimize it again afterwards.
$minimized = New-Object System.Collections.Generic.List[IntPtr]
function Unminimize($h) {
  if ($W::IsIconic($h)) { [void]$W::ShowWindow($h, 4); $minimized.Add($h); Start-Sleep -Milliseconds 800 }  # SW_SHOWNOACTIVATE
}
function Reminimize { foreach ($h in $minimized) { if ($W::IsWindow($h)) { [void]$W::ShowWindow($h, 7) } }; $minimized.Clear() }  # SW_SHOWMINNOACTIVE

# MT5 greys out Charts -> Expert List while the terminal runs no EA, and then ignores the command.
# Menu states are refreshed when their popup opens, so refresh the one holding the item first.
function No-Experts($main) {
  $menu = $W::GetMenu($main)
  for ($i = 0; $i -lt $W::GetMenuItemCount($menu); $i++) {
    $sub = $W::GetSubMenu($menu, $i)
    if ($sub -ne $Z -and $W::GetMenuState($sub, [uint32]33015, 0) -ne [uint32]::MaxValue) {
      [void]$W::SendMessage($main, 0x0117, $sub, [IntPtr]$i)  # WM_INITMENUPOPUP
      return (($W::GetMenuState($sub, [uint32]33015, 0) -band 3) -ne 0)  # MF_GRAYED | MF_DISABLED
    }
  }
  $false
}

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
  if (No-Experts $p.MainWindowHandle) { return 0 }
  $before = Dialogs $p.Id
  [void]$W::PostMessage($p.MainWindowHandle, 0x0111, [IntPtr]33015, $Z)  # Charts -> Expert List
  $l = New-Dialog $p.Id $before 3 'Experts'
  if ($l -eq $Z) { throw 'Expert List did not open' }
  $n = [int]$W::SendMessage($W::GetDlgItem($l, 10309), 0x1004, $Z, $Z)  # LVM_GETITEMCOUNT
  Cancel-Dialog $l
  $n
}

function Frames($mdi) { $l = @(); $c = $Z; while (($c = $W::FindWindowEx($mdi, $c, [NullString]::Value, [NullString]::Value)) -ne $Z) { $l += $c }; , $l }

$EA_NAME = @{ exporter = 'MT5_TradeExporter'; sender = 'FX Blue - TradeCopy Sender' }
# expertmode as found in working profiles on azeem-pc (sender 4, exporter 0).
$EA_MODE = @{ exporter = 0; sender = 4 }
# The exporter's inputs from a working profile; its defaults are not known to be the same.
$EXPORTER_INPUTS = @('ExportIntervalMinutes=1', 'OpenTradesIntervalSeconds=30', 'ExportFolderPath=', 'EnableExport=true',
  'EnableOpenTrades=true', 'EnableLogging=true', 'MaxHistoryDays=90')

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

$props = $Z; $mdi = $Z; $newChart = $Z; $attached = $false; $tplFile = $null; $tplBackup = $null; $swapped = $false
# Put back the default.tpl this run replaced (or remove the one it wrote). Safe to call twice.
function Restore-DefaultTemplate {
  if (!$script:swapped) { return }
  Remove-Item $script:tplFile -Force -ErrorAction SilentlyContinue
  if (Test-Path $script:tplBackup) { Move-Item $script:tplBackup $script:tplFile -Force }
  $script:swapped = $false
}
try {
  if ($Login -notmatch '^\d+$') { throw 'bad -Login' }
  if ($Expert -eq 'sender' -and $Channel -notmatch '^[A-Za-z0-9_-]{1,32}$') { throw 'sender needs a valid -Channel' }
  $stamp = [guid]::NewGuid().ToString('N')

  # 1. find: the terminal, its menu items, and how many EAs it runs now.
  $p = @(Get-Process terminal64 -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne $Z -and (T $_.MainWindowHandle) -match "^\s*$Login\b" }) | Select-Object -First 1
  if (!$p) { throw "no MT5 terminal for login $Login" }
  $main = $p.MainWindowHandle
  Unminimize $main
  $menu = $W::GetMenu($main)
  $mdi = $W::FindWindowEx($main, $Z, 'MDIClient', [NullString]::Value)
  if ($mdi -eq $Z) { throw 'MDIClient not found' }
  $chartId = Find-Leaf (Sub-Menu $menu 'File/New Chart') 'XAUUSD'
  if ($null -eq $chartId) { throw 'File/New Chart/.../XAUUSD not found' }
  $dataDir = Data-Folder (Split-Path $p.Path -Parent)
  $eaFile = Join-Path $dataDir "MQL5\Experts\$($EA_NAME[$Expert]).ex5"
  if (!(Test-Path $eaFile)) { throw "$($EA_NAME[$Expert]).ex5 is not installed in this terminal" }
  $tplFile = Join-Path $dataDir 'MQL5\Profiles\Templates\default.tpl'
  $tplBackup = "$tplFile.copier-$stamp"
  $count0 = Expert-Count $p

  # 2. template: default.tpl with the EA, so the next new chart gets it.
  $step = 'template'
  if ($Expert -eq 'exporter') {
    $inputs = $EXPORTER_INPUTS
  } else {
    $lines = if ($BaseSet -and (Test-Path $BaseSet)) { [IO.File]::ReadAllText($BaseSet) -split "`r?`n" } else { @() }
    # .set values may end in ||min||step||max||flag; a template holds the value only.
    $inputs = @($lines | Where-Object { $_ -match '^\w+=' -and $_ -notmatch '^Channel=' } | ForEach-Object { ($_ -split '\|\|')[0] })
    $inputs = @("Channel=$Channel") + $inputs
  }
  $tpl = (@('<chart>', 'symbol=XAUUSD', 'period_type=1', 'period_size=1', 'mode=1', '',
      '<expert>', "name=$($EA_NAME[$Expert])", "path=Experts\$($EA_NAME[$Expert]).ex5", "expertmode=$($EA_MODE[$Expert])", '<inputs>') +
    $inputs + @('</inputs>', '</expert>', '', '<window>', 'height=100', '', '<indicator>', 'name=Main', 'path=', 'apply=1', 'show_data=1',
      '</indicator>', '</window>', '</chart>', '')) -join "`r`n"
  if (Test-Path $tplFile) { Move-Item $tplFile $tplBackup -Force }
  $swapped = $true
  [IO.File]::WriteAllText($tplFile, $tpl, [Text.Encoding]::Unicode)

  # 3. chart: a new XAUUSD chart, which MT5 builds from default.tpl.
  $step = 'chart'
  $before = Frames $mdi
  [void]$W::PostMessage($main, 0x0111, [IntPtr][int]$chartId, $Z)
  $t0 = Get-Date
  # Frames returns its list as one pipeline object, so assign it before filtering.
  do { Start-Sleep -Milliseconds 300; $now = Frames $mdi; $newChart = $now | Where-Object { $before -notcontains $_ } | Select-Object -First 1 }
  while (!$newChart -and ((Get-Date) - $t0).TotalSeconds -lt 5)
  if (!$newChart) { $newChart = $Z; throw 'new chart did not open' }
  Start-Sleep 3  # let the EA start
  Restore-DefaultTemplate
  $extra = New-Dialog $p.Id (Dialogs $p.Id) 1
  if ($extra -ne $Z) { throw "unexpected dialog after opening the chart: '$(T $extra)'" }

  # 4. verify: exactly one more EA.
  $step = 'verify'
  $count1 = Expert-Count $p
  if ($count1 -gt $count0) { $attached = $true }
  if ($count1 -ne $count0 + 1) { throw "Expert List has $count1 EAs, expected $($count0 + 1)" }

  # 5. persist
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
  Restore-DefaultTemplate
  # A chart this run opened that never got its EA is closed again.
  if (!$attached -and $newChart -ne $Z -and $W::IsWindow($newChart)) { [void]$W::SendMessage($mdi, 0x0221, $newChart, $Z) }  # WM_MDIDESTROY
  Reminimize
  Get-ChildItem $workDir -Filter '*.set' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($OutFile, ($res | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
}
exit 0

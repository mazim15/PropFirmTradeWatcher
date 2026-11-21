# Change inputs of one FX Blue copier EA, with read-back.
#
# Finds the EA: an MT4 TradeCopy Receiver by -Channel, or the single MT5 TradeCopy Sender in
# the terminal whose title starts with -Login. Saves its settings, loads a copy with only the
# -Set keys changed, presses OK, reopens and saves again to confirm, then makes the change
# survive a restart (MT4: patch the matching profiles\default\chart*.chr; MT5: File -> Profiles
# -> Save). The only dialog it presses OK on is that EA's properties, and only after Load
# succeeded. Every other dialog this run opened is cancelled, on every path. Controls are
# addressed by ID or name; menu items by their text.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File copier-set-input.ps1
#          -Role receiver|sender (-Channel <name> | -Login <digits>) -Set "Key=Value[;Key=Value]" -OutFile <path>
# Writes { ok, before, after, chartFile, step, error } as UTF-8 JSON and exits 0.
# before/after hold the -Set keys' values as read before the change and on read-back.
param(
  [Parameter(Mandatory = $true)][ValidateSet('receiver', 'sender')][string]$Role,
  [string]$Channel,
  [string]$Login,
  [Parameter(Mandatory = $true)][string]$Set,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
$workDir = Join-Path $env:TEMP 'copier-set-input'
New-Item -ItemType Directory -Force $workDir | Out-Null
$inv = [Globalization.CultureInfo]::InvariantCulture
$res = [ordered]@{ ok = $false; before = $null; after = $null; chartFile = $null; step = $null; error = $null }
$step = 'find'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class CopierInputWin {
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
$W = [CopierInputWin]
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

# Menu item ID by its text path ('File/Profiles/Save'), ignoring & and shortcut text; $null if absent.
function Find-MenuId($m, $path) {
  $parts = $path -split '/'
  for ($d = 0; $d -lt $parts.Count; $d++) {
    $n = $W::GetMenuItemCount($m); $found = $false
    for ($i = 0; $i -lt $n; $i++) {
      $sb = New-Object System.Text.StringBuilder 256; [void]$W::GetMenuString($m, [uint32]$i, $sb, 256, 0x400)
      $txt = ($sb.ToString() -replace '&', '') -replace "`t.*", ''
      if ($txt -eq $parts[$d]) {
        if ($d -eq $parts.Count - 1) { return $W::GetMenuItemID($m, $i) }
        $m = $W::GetSubMenu($m, $i); $found = $true; break
      }
    }
    if (!$found) { return $null }
  }
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

# A key's value; MT5 appends ||min||step||max||flag, so cut at the first |.
function Val($t, $k) { [regex]::Match($t, "(?m)^$([regex]::Escape($k))=([^\r\n|]*)").Groups[1].Value }
function Has($t, $k) { [regex]::IsMatch($t, "(?m)^$([regex]::Escape($k))=") }
function Num($s) { $d = 0.0; if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, $inv, [ref]$d)) { $d } else { $null } }
function Enc($path) { if ([IO.File]::ReadAllBytes($path)[0] -eq 0xFF) { [Text.Encoding]::Unicode } else { [Text.Encoding]::Default } }
# Replace each wanted key's value, keeping any MT5 ||… suffix.
function Apply($text) {
  foreach ($k in $want.Keys) {
    $v = $want[$k]
    $text = [regex]::Replace($text, "(?m)^($([regex]::Escape($k))=)[^\r\n|]*", { param($m) $m.Groups[1].Value + $v }.GetNewClosure())
  }
  $text
}
# Numbers compare as numbers, true/false case-insensitively, anything else exactly.
function Same($a, $b) {
  $na = Num $a; $nb = Num $b
  if ($null -ne $na -and $null -ne $nb) { return $na -eq $nb }
  if ($a -match '^(true|false)$') { return $a -ieq $b }
  $a -ceq $b
}
function Pick($t) { $o = [ordered]@{}; foreach ($k in $want.Keys) { $o[$k] = Val $t $k }; $o }

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

# MT4: activate the chart frame and post F7; returns its properties dialog or $Z.
function Open-ChartProps($p, $mdi, $f) {
  [void]$W::SendMessage($mdi, 0x0222, $f, $Z)  # WM_MDIACTIVATE
  Start-Sleep -Milliseconds 400
  $before = Dialogs $p.Id
  [void]$W::PostMessage($f, 0x0100, [IntPtr]0x76, [IntPtr]0x00410001)  # F7 down
  [void]$W::PostMessage($f, 0x0101, [IntPtr]0x76, [IntPtr]0xC0410001)  # F7 up
  New-Dialog $p.Id $before 3 'Expert*'
}

# MT5: select row $i of the open Expert List and press Properties; returns the dialog or $Z.
function Open-RowProps($p, $list, $i) {
  $lv = $W::GetDlgItem($list, 10309)
  [void]$W::PostMessage($lv, 0x0100, [IntPtr]0x24, [IntPtr]0x01470001)  # VK_HOME
  for ($k = 0; $k -lt $i; $k++) { [void]$W::PostMessage($lv, 0x0100, [IntPtr]0x28, [IntPtr]0x01500001) }  # VK_DOWN
  Start-Sleep -Milliseconds 300
  $before = Dialogs $p.Id
  Click ($W::GetDlgItem($list, 10001))  # Properties
  New-Dialog $p.Id $before 3
}

function Open-ExpertList($p) {
  $before = Dialogs $p.Id
  [void]$W::PostMessage($p.MainWindowHandle, 0x0111, [IntPtr]33015, $Z)  # Charts -> Expert List
  $l = New-Dialog $p.Id $before 3 'Experts'
  if ($l -eq $Z) { throw 'Expert List did not open' }
  $l
}

$props = $Z; $mdi = $Z; $active = $Z; $list = $Z
try {
  # Parse -Set into an ordered map; values may not hold line breaks or |.
  $want = [ordered]@{}
  foreach ($pair in ($Set -split ';')) {
    if (!$pair.Trim()) { continue }
    $kv = $pair -split '=', 2
    if ($kv.Count -ne 2 -or $kv[0].Trim() -notmatch '^\w+$' -or $kv[1] -match '[\r\n|]') { throw "bad -Set '$pair'" }
    $want[$kv[0].Trim()] = $kv[1].Trim()
  }
  if ($want.Count -eq 0) { throw '-Set is empty' }
  if ($Role -eq 'receiver' -and !$Channel) { throw 'receiver needs -Channel' }
  if ($Role -eq 'sender' -and $Login -notmatch '^\d+$') { throw 'sender needs -Login digits' }
  $stamp = [guid]::NewGuid().ToString('N')

  # 1. find: the EA's properties dialog, left open.
  $p = $null; $target = $Z; $row = -1
  if ($Role -eq 'receiver') {
    foreach ($proc in @(Get-Process terminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne $Z })) {
      $m = $W::FindWindowEx($proc.MainWindowHandle, $Z, 'MDIClient', [NullString]::Value)
      if ($m -eq $Z) { continue }
      $act = $W::SendMessage($m, 0x0229, $Z, $Z)  # WM_MDIGETACTIVE
      $frames = @(); $c = $Z
      while (($c = $W::FindWindowEx($m, $c, [NullString]::Value, [NullString]::Value)) -ne $Z) { $frames += $c }
      foreach ($f in $frames) {
        $h = Open-ChartProps $proc $m $f
        if ($h -eq $Z) { continue }
        if ((T $h) -notmatch 'TradeCopy Receiver') { Cancel-Dialog $h; continue }
        $t = Save-Settings $proc $h (Join-Path $workDir "$stamp-find.set")
        Remove-Item (Join-Path $workDir "$stamp-find.set") -Force -ErrorAction SilentlyContinue
        if ((Val $t 'Channel') -ceq $Channel) { $p = $proc; $mdi = $m; $active = $act; $target = $f; $props = $h; break }
        Cancel-Dialog $h
      }
      if ($target -ne $Z) { break }
      if ($act -ne $Z -and $W::IsWindow($act)) { [void]$W::SendMessage($m, 0x0222, $act, $Z) }
    }
    if ($target -eq $Z) { throw "no receiver with channel $Channel" }
  } else {
    $p = @(Get-Process terminal64 -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne $Z -and (T $_.MainWindowHandle) -match "^\s*$Login\b" }) | Select-Object -First 1
    if (!$p) { throw "no MT5 terminal for login $Login" }
    $list = Open-ExpertList $p
    $count = [int]$W::SendMessage(($W::GetDlgItem($list, 10309)), 0x1004, $Z, $Z)  # LVM_GETITEMCOUNT
    $rows = @()
    for ($i = 0; $i -lt $count; $i++) {
      $h = Open-RowProps $p $list $i
      if ($h -eq $Z) { throw "Expert List row ${i}: properties did not open" }
      if ((T $h) -match 'TradeCopy Sender') { $rows += $i }
      Cancel-Dialog $h
    }
    if ($rows.Count -eq 0) { throw 'No sender in terminal' }
    if ($rows.Count -gt 1) { throw 'More than one sender in terminal' }
    $row = $rows[0]
    $props = Open-RowProps $p $list $row
    if ($props -eq $Z -or (T $props) -notmatch 'TradeCopy Sender') { throw 'could not reopen sender properties' }
  }

  # 2. save-before: current settings, then a copy with only the -Set keys changed.
  $step = 'save-before'
  $beforeFile = Join-Path $workDir "$stamp-before.set"; $afterFile = Join-Path $workDir "$stamp-after.set"
  $t = Save-Settings $p $props $beforeFile
  foreach ($k in $want.Keys) { if (!(Has $t $k)) { throw "No input $k" } }
  $res.before = Pick $t
  [IO.File]::WriteAllText($afterFile, (Apply $t), (Enc $beforeFile))

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

  # 5. read-back: reopen the same chart / list row, save, compare every -Set key.
  $step = 'read-back'
  $props = if ($Role -eq 'receiver') { Open-ChartProps $p $mdi $target } else { Open-RowProps $p $list $row }
  if ($props -eq $Z) { throw 'could not reopen properties' }
  $t2 = Save-Settings $p $props (Join-Path $workDir "$stamp-readback.set")
  Cancel-Dialog $props; $props = $Z
  $res.after = Pick $t2
  foreach ($k in $want.Keys) { if (!(Same $want[$k] (Val $t2 $k))) { throw "READ-BACK MISMATCH $k" } }
  # A receiver is identified by its channel: unless the channel was the change, it must not move.
  if ($Role -eq 'receiver' -and !$want.Contains('Channel') -and (Val $t2 'Channel') -cne $Channel) { throw 'READ-BACK MISMATCH Channel' }

  # 6. persist: survive a restart.
  $step = 'persist'
  if ($Role -eq 'receiver') {
    # MT4 often rewrites the chart file itself on OK, so on a rename it may already hold the new name.
    $names = @($Channel); if ($want.Contains('Channel')) { $names += $want['Channel'] }
    $dir = Join-Path (Data-Folder (Split-Path $p.Path -Parent)) 'profiles\default'
    $chr = Get-ChildItem (Join-Path $dir 'chart*.chr') -ErrorAction SilentlyContinue |
      Where-Object { $names -ccontains (Val ([IO.File]::ReadAllText($_.FullName)) 'Channel') } | Select-Object -First 1
    if (!$chr) { throw "change is live, but no chart file has channel $Channel (lost on restart)" }
    [IO.File]::WriteAllText($chr.FullName, (Apply ([IO.File]::ReadAllText($chr.FullName))), (Enc $chr.FullName))
    $res.chartFile = $chr.Name
  } else {
    Cancel-Dialog $list; $list = $Z  # the menu needs the main window free
    $id = Find-MenuId ($W::GetMenu($p.MainWindowHandle)) 'File/Profiles/Save'
    if (!$id) { throw 'change is live, but File/Profiles/Save was not found (lost on restart)' }
    [void]$W::PostMessage($p.MainWindowHandle, 0x0111, [IntPtr][int]$id, $Z)
    Start-Sleep 2
  }

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

# One-time per PC. Moves MT4/MT5 shortcuts out of shell:startup into %USERPROFILE%\TradingStartup
# and puts the delayed launcher in Startup. Rerunning moves only new shortcuts. -Uninstall reverses it.
# Only shortcuts whose target is terminal.exe / terminal64.exe move; the watcher shortcut stays.
param([switch]$Uninstall)

$startup = [Environment]::GetFolderPath('Startup')
$dest = Join-Path $env:USERPROFILE 'TradingStartup'
$movedFile = Join-Path $dest 'moved.txt'
$launcher = Join-Path $startup 'start-terminals.cmd'

if ($Uninstall) {
  $back = 0
  if (Test-Path $movedFile) {
    foreach ($name in Get-Content $movedFile) {
      if (-not $name) { continue }
      $src = Join-Path $dest $name
      if (Test-Path -LiteralPath $src) { Move-Item -LiteralPath $src -Destination (Join-Path $startup $name) -Force; $back++ }
    }
    Remove-Item $movedFile
  }
  if (Test-Path $launcher) { Remove-Item $launcher }
  Remove-Item (Join-Path $dest 'start-terminals.ps1') -ErrorAction SilentlyContinue
  Write-Output "$back restored, launcher removed"
  return
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'start-terminals.ps1') $dest -Force
Copy-Item (Join-Path $PSScriptRoot 'start-terminals.cmd') $startup -Force

$shell = New-Object -ComObject WScript.Shell
$moved = 0
foreach ($lnk in Get-ChildItem -Path $startup -Filter '*.lnk') {
  $target = $shell.CreateShortcut($lnk.FullName).TargetPath
  if ($target -notmatch '\\terminal(64)?\.exe$') { continue }
  Move-Item -LiteralPath $lnk.FullName -Destination (Join-Path $dest $lnk.Name) -Force
  Add-Content -Path $movedFile -Value $lnk.Name
  $moved++
}
Write-Output "$moved moved"

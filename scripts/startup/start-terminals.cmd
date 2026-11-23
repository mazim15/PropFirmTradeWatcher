@echo off
rem Delayed, staggered MT4/MT5 start after boot. Installed into shell:startup by install-startup-delay.ps1.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%USERPROFILE%\TradingStartup\start-terminals.ps1"

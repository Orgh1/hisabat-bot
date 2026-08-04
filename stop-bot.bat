@echo off
REM stops the bot (kills n8n processes only - nothing else)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|cmd' -and $_.CommandLine -match 'n8n' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host 'Bot stopped.'"
pause

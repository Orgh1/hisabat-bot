@echo off
REM ===== bot launcher: reads .env then starts n8n locally =====
cd /d "%~dp0"
if not exist ".env" (
  echo [ERROR] .env not found - copy .env.example to .env and fill it
  pause
  exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not "%%b"=="" set "%%a=%%b"
set GENERIC_TIMEZONE=%TIMEZONE%
set TZ=%TIMEZONE%
set N8N_SECURE_COOKIE=false
set N8N_BLOCK_ENV_ACCESS_IN_NODE=false
set N8N_RUNNERS_ENABLED=true
REM prune executions history (keep 48h / max 5000) and compact DB on startup
set EXECUTIONS_DATA_PRUNE=true
set EXECUTIONS_DATA_MAX_AGE=48
set EXECUTIONS_DATA_PRUNE_MAX_COUNT=5000
set DB_SQLITE_VACUUM_ON_STARTUP=true
echo Starting n8n ... open http://localhost:5678
npx --yes n8n

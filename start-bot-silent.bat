@echo off
REM silent wrapper: runs the bot and appends output to bot.log (absolute paths, no cwd assumptions)
call "%~dp0start-bot.bat" >> "%~dp0bot.log" 2>&1

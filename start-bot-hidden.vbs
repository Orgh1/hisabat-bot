' launches the bot with NO visible window (output goes to bot.log)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\start-bot-silent.bat""", 0, False

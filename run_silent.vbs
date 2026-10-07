Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
jsPath = fso.BuildPath(scriptDir, "toc_daemon.js")
ws.Run "node """ & jsPath & """", 0, False

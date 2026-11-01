Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodeExe = "C:\Program Files\nodejs\node.exe"
repoDaemonJs = "C:\Study\antigravity-minimap\toc_daemon.js"

targetScript = repoDaemonJs
ws.Run """" & nodeExe & """ """ & targetScript & """", 0, False

On Error Resume Next
Set ws = CreateObject("WScript.Shell")
up = ws.ExpandEnvironmentStrings("%USERPROFILE%")
nodeExe = "C:\Program Files\nodejs\node.exe"
daemonJs = up & "\.gemini\antigravity\toc_daemon.js"
Do
    ws.Run """" & nodeExe & """ """ & daemonJs & """", 0, True
    WScript.Sleep 1000
Loop
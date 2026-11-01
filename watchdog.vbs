On Error Resume Next
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodeExe = "C:\Program Files\nodejs\node.exe"
repoDaemonJs = "C:\Study\antigravity-minimap\toc_daemon.js"
userDaemonJs = ws.ExpandEnvironmentStrings("%USERPROFILE%") & "\.gemini\antigravity\toc_daemon.js"

targetScript = repoDaemonJs
If Not fso.FileExists(targetScript) Then
    targetScript = userDaemonJs
End If

Do
    ws.Run """" & nodeExe & """ """ & targetScript & """", 0, True
    WScript.Sleep 1000
Loop

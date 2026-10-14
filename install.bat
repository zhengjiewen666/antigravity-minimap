@echo off
chcp 65001 >nul
title Antigravity Minimap & Gemini Fork 一键安装程序

echo ========================================================
echo   Google Antigravity 提问导航目录与 Gemini 对话分叉增强
echo               一键安装与多重自启常驻配置
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境，请先安装 Node.js (https://nodejs.org/)！
    pause
    exit /b 1
)

set "TARGET_DIR=%USERPROFILE%\.gemini\antigravity"
set "CONFIG_DIR=%USERPROFILE%\.gemini\config"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_TARGET=%STARTUP_FOLDER%\antigravity_minimap.vbs"

echo [1/4] 正在同步守护程序、看门狗与自愈守卫...
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
copy /y "%~dp0toc_daemon.js" "%TARGET_DIR%\toc_daemon.js" >nul
copy /y "%~dp0watchdog.vbs" "%TARGET_DIR%\watchdog.vbs" >nul
copy /y "%~dp0guard.js" "%TARGET_DIR%\guard.js" >nul

echo [2/4] 正在配置 Windows 开机与登录静默自启项...
powershell -NoProfile -Command "$vbs = 'On Error Resume Next`nSet ws = CreateObject(\"WScript.Shell\")`nup = ws.ExpandEnvironmentStrings(\"%USERPROFILE%\")`nnodeExe = \"C:\Program Files\nodejs\node.exe\"`ndaemonJs = up & \"\.gemini\antigravity\toc_daemon.js\"`nws.Run \"\"\"\" & nodeExe & \"\"\" \"\"\" & daemonJs & \"\"\"\", 0, False'; [System.IO.File]::WriteAllText($env:VBS_TARGET, $vbs, [System.Text.Encoding]::ASCII)"

rem 写入注册表用户自启 Run 项
powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AntigravityMinimap' -Value ('wscript.exe \"' + $env:VBS_TARGET + '\"')"

echo [3/4] 正在配置 Antigravity 全局生命周期自愈钩子 (hooks.json)...
node -e "
const fs = require('fs');
const path = require('path');
const configDir = path.join(process.env.USERPROFILE, '.gemini', 'config');
const hooksPath = path.join(configDir, 'hooks.json');
let hooks = {};
try { if (fs.existsSync(hooksPath)) hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')); } catch(e) {}
hooks['minimap-guard'] = {
  PreInvocation: [
    {
      type: 'command',
      command: 'node \"' + path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'guard.js').replace(/\\/g, '/') + '\"'
    }
  ]
};
fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), 'utf8');
"

echo [4/4] 正在启动后台守护服务...
wscript.exe "%VBS_TARGET%"

echo.
echo ========================================================
echo [✔] 安装与多重自启配置成功！
echo     1. Windows 开机/登录自启项已配置 (Startup + Registry Run)
echo     2. Antigravity 运行自愈守卫已激活 (hooks.json)
echo     3. 悬浮球提问导航与分支管理服务已在后台运行！
echo ========================================================
echo.
pause

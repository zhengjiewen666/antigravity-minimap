@echo off
chcp 65001 >nul
title Antigravity Minimap 一键安装程序

echo ========================================================
echo       Google Antigravity 会话小地图与提问目录
echo                   一键安装与自启配置
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境，请先安装 Node.js (https://nodejs.org/)！
    pause
    exit /b 1
)

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_TARGET=%STARTUP_FOLDER%\antigravity_minimap.vbs"

echo [1/3] 正在同步守护程序至系统配置目录...
if not exist "%USERPROFILE%\.gemini\antigravity" mkdir "%USERPROFILE%\.gemini\antigravity"
copy /y "%~dp0toc_daemon.js" "%USERPROFILE%\.gemini\antigravity\toc_daemon.js" >nul

echo [2/3] 正在配置 Windows 开机静默启动项...
powershell -NoProfile -Command "$vbs = 'Set ws = CreateObject(\"Wscript.Shell\")`nuserProfile = ws.ExpandEnvironmentStrings(\"%USERPROFILE%\")`nws.Run \"\"\"node\"\" \"\"\" & userProfile & \"\.gemini\antigravity\toc_daemon.js\"\"\", 0, False'; [System.IO.File]::WriteAllText($env:VBS_TARGET, $vbs, [System.Text.Encoding]::ASCII)"

echo [3/3] 正在启动后台守护服务...
wscript.exe "%VBS_TARGET%"

echo.
echo ========================================================
echo [✔] 安装成功！
echo     Antigravity 会话小地图已常驻后台静默运行。
echo     只要您打开 Antigravity，右侧就会自动出现提问小地图！
echo ========================================================
echo.
pause

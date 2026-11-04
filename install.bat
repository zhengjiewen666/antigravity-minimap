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

echo [2/4] 正在配置 Windows 开机与登录静默自启项 (纯 ASCII 路径兼容)...
node "%~dp0setup_autostart.js"

echo [3/4] 正在启动后台守护服务...
wscript.exe "%~dp0run_daemon.vbs"

echo.
echo ========================================================
echo [✔] 安装与多重自启配置成功！
echo     1. Windows 开机/登录自启项已配置 (Startup + Registry Run)
echo     2. Antigravity 运行自愈守卫已激活 (hooks.json SessionStart + PreInvocation)
echo     3. 悬浮球提问导航与分支管理服务已在后台运行！
echo ========================================================
pause

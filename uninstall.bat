@echo off
chcp 65001 >nul
title Antigravity Minimap 卸载程序

echo ========================================================
echo       Google Antigravity 会话小地图与提问目录
echo                   一键卸载程序
echo ========================================================
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_TARGET=%STARTUP_FOLDER%\antigravity_minimap.vbs"

echo [1/4] 正在删除开机与登录自启动配置...
if exist "%VBS_TARGET%" del /f /q "%VBS_TARGET%" >nul 2>nul
powershell -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AntigravityMinimap' -ErrorAction SilentlyContinue"

echo [2/4] 正在清理 Antigravity 全局守卫钩子...
node -e "
const fs = require('fs');
const path = require('path');
const hooksPath = path.join(process.env.USERPROFILE, '.gemini', 'config', 'hooks.json');
try {
  if (fs.existsSync(hooksPath)) {
    const h = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    delete h['minimap-guard'];
    fs.writeFileSync(hooksPath, JSON.stringify(h, null, 2), 'utf8');
  }
} catch(e) {}
" >nul 2>nul

echo [3/4] 正在终止看门狗进程...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name = 'wscript.exe'\" | Where-Object { $_.CommandLine -like '*watchdog.vbs*' -or $_.CommandLine -like '*antigravity_minimap.vbs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [4/4] 正在终止后台常驻的守护进程...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr "48899" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
)

echo.
echo ========================================================
echo [✔] 卸载完成！已完全停止后台服务并移除全部自启与钩子配置。
echo ========================================================
echo.
pause

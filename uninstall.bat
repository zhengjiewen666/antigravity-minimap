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

echo [1/3] 正在删除开机自启动配置...
if exist "%VBS_TARGET%" (
    del /f /q "%VBS_TARGET%"
    echo 已成功移除开机自启项。
) else (
    echo 未发现开机自启项，已跳过。
)

echo [2/3] 正在终止看门狗进程...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name = 'wscript.exe'\" | Where-Object { $_.CommandLine -like '*watchdog.vbs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [3/3] 正在终止后台常驻的守护进程...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr "48899" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
)

echo.
echo ========================================================
echo [✔] 卸载完成！已完全停止后台服务并移除开机启动。
echo ========================================================
echo.
pause

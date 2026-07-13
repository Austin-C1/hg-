@echo off
setlocal
chcp 65001 >nul
set "CROWN_PACKAGE_ROOT=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CROWN_PACKAGE_ROOT%launcher\start.ps1"
set "CROWN_EXIT_CODE=%ERRORLEVEL%"

if not "%CROWN_EXIT_CODE%"=="0" (
  echo.
  echo 皇冠监控程序启动失败。
  echo 日志位置：%LOCALAPPDATA%\CrownMonitor\logs\launcher.log
  echo 请确认 ZIP 已完整解压、文件未被安全软件隔离，然后重新启动。
  pause
)

exit /b %CROWN_EXIT_CODE%

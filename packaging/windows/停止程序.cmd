@echo off
setlocal
chcp 65001 >nul
set "CROWN_PACKAGE_ROOT=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CROWN_PACKAGE_ROOT%launcher\stop.ps1"
set "CROWN_EXIT_CODE=%ERRORLEVEL%"

if not "%CROWN_EXIT_CODE%"=="0" (
  echo.
  echo 未能安全停止皇冠监控程序。
  echo 日志位置：%LOCALAPPDATA%\CrownMonitor\logs\launcher.log
  echo 为避免结束错误的进程，程序没有执行强制批量终止。
  pause
)

exit /b %CROWN_EXIT_CODE%

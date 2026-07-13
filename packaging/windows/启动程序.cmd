@echo off
setlocal
set "CROWN_PACKAGE_ROOT=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CROWN_PACKAGE_ROOT%launcher\start.ps1"
set "CROWN_EXIT_CODE=%ERRORLEVEL%"

if not "%CROWN_EXIT_CODE%"=="0" (
  echo.
  echo Crown Monitor failed to start.
  echo Log: %LOCALAPPDATA%\CrownMonitor\logs\launcher.log
  echo Verify that the ZIP was fully extracted and no file was quarantined, then retry.
  pause
)

exit /b %CROWN_EXIT_CODE%

@echo off
setlocal
set "CROWN_PACKAGE_ROOT=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CROWN_PACKAGE_ROOT%launcher\stop.ps1"
set "CROWN_EXIT_CODE=%ERRORLEVEL%"

if not "%CROWN_EXIT_CODE%"=="0" (
  echo.
  echo Crown Monitor could not be stopped safely.
  echo Log: %LOCALAPPDATA%\CrownMonitor\logs\launcher.log
  echo No process was force-killed because its identity could not be verified.
  pause
)

exit /b %CROWN_EXIT_CODE%

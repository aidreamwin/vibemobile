@echo off
title VibeMobile Service - Uninstall

rem NOTE: keep this file pure ASCII. See the note in install-service.bat --
rem cmd.exe parses batch files using the ANSI code page, so UTF-8 multibyte
rem text here would corrupt the script. Chinese output lives in the .ps1 file.

fsutil dirty query %systemdrive% >nul 2>&1
if %errorlevel% neq 0 (
  echo Administrator rights are required. Requesting elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

powershell -NoProfile -File "%~dp0uninstall-service.ps1" %*
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% neq 0 (
  echo [FAILED] Uninstall did not complete. Exit code %EXITCODE%
) else (
  echo [DONE] Press any key to close this window...
)
pause >nul
exit /b %EXITCODE%

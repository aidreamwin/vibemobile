@echo off
title VibeMobile Runner Service - Install

rem NOTE: keep this file pure ASCII.
rem cmd.exe parses batch files using the ANSI code page; UTF-8 multibyte text
rem here desynchronises the parser and turns later lines into garbage commands.
rem All user-facing Chinese output lives in install-runner-service.ps1
rem (UTF-8 with BOM).

rem Registering a service needs administrator rights. fsutil always fails
rem without elevation, so it is a reliable probe.
fsutil dirty query %systemdrive% >nul 2>&1
if %errorlevel% neq 0 (
  echo Administrator rights are required. Requesting elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

rem No -ExecutionPolicy override: a local script is allowed under RemoteSigned.
powershell -NoProfile -File "%~dp0install-runner-service.ps1" %*
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% neq 0 (
  echo [FAILED] Install did not complete. Exit code %EXITCODE%
) else (
  echo [DONE] Press any key to close this window...
)
pause >nul
exit /b %EXITCODE%

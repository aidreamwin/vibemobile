@echo off
title VibeMobile Service - Install

rem NOTE: keep this file pure ASCII.
rem cmd.exe parses batch files using the ANSI code page; UTF-8 multibyte text
rem here desynchronises the parser and turns later lines into garbage commands.
rem All user-facing Chinese output lives in install-service.ps1 (UTF-8 with BOM).

rem Registering a service needs administrator rights. fsutil always fails
rem without elevation, so it is a reliable probe. (Not "net session" -- that
rem misfires when the Server service is disabled.)
fsutil dirty query %systemdrive% >nul 2>&1
if %errorlevel% neq 0 (
  echo Administrator rights are required. Requesting elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

rem No -ExecutionPolicy override: this is a local script and RemoteSigned
rem already permits it. If your policy is Restricted, run once:
rem   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
powershell -NoProfile -File "%~dp0install-service.ps1" %*
set EXITCODE=%errorlevel%

echo.
if %EXITCODE% neq 0 (
  echo [FAILED] Install did not complete. Exit code %EXITCODE%
) else (
  echo [DONE] Press any key to close this window...
)
pause >nul
exit /b %EXITCODE%

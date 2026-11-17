@echo off
rem BeakSight launcher for Windows (design: doc/design/2026-11-08-beaksight-root-launcher-design.md).
rem Double-click to start. Arguments are passed to the launcher as they are (example: BeakSight.cmd --port 4400).
rem 1. Prepare a Node.js that satisfies engines.node of package.json (tools\launcher\bootstrap.ps1).
rem    It downloads only from nodejs.org into local\runtime\ when needed. The PC settings and PATH are not changed.
rem 2. Put that Node.js first on PATH for this window only, and run the launcher body.
rem 3. On an error (exit code other than 0), wait for a key so that the window does not close at once.
rem    On exit code 0 (for example, the admin page was closed in the browser), close without waiting.
rem This file is ASCII only with CRLF line ends (cmd.exe reads it in the ANSI code page).
setlocal
pushd "%~dp0"
set "BEAKSIGHT_EXIT=1"
set "BEAKSIGHT_NODE_DIR="
for /f "usebackq delims=" %%D in (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "tools\launcher\bootstrap.ps1"`) do set "BEAKSIGHT_NODE_DIR=%%D"
if not defined BEAKSIGHT_NODE_DIR goto done
set "PATH=%BEAKSIGHT_NODE_DIR%;%PATH%"
"%BEAKSIGHT_NODE_DIR%\node.exe" "tools\launcher\start.mjs" %*
set "BEAKSIGHT_EXIT=%ERRORLEVEL%"
:done
popd
if not "%BEAKSIGHT_EXIT%"=="0" pause
exit /b %BEAKSIGHT_EXIT%

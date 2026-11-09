@echo off
setlocal
pushd "%~dp0..\02_Aplikacja_kod" || exit /b 1
node server.mjs
set "status=%errorlevel%"
popd
if not "%status%"=="0" pause
exit /b %status%

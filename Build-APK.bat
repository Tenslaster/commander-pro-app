@echo off
REM Wrapper → scripts\build-apk.bat
cd /d "%~dp0"
call "%~dp0scripts\build-apk.bat"
exit /b %ERRORLEVEL%

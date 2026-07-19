@echo off
REM Wrapper → scripts\build-ipa.bat
cd /d "%~dp0"
call "%~dp0scripts\build-ipa.bat"
exit /b %ERRORLEVEL%

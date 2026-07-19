@echo off
setlocal EnableExtensions
title Commander PRO - smoke tests
cd /d "%~dp0.."
echo Running smoke tests...
python scripts\smoke_test.py
echo.
pause
endlocal

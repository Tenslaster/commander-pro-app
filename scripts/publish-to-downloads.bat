@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Commander PRO - Publish builds to downloads
color 0E
cd /d "%~dp0.."

set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;%PATH%"

echo ========================================
echo  Fetch latest APK (EAS) + IPA (GitHub)
echo  into dist\apk and dist\ipa
echo ========================================
echo.

if not exist "dist\apk" mkdir "dist\apk"
if not exist "dist\ipa" mkdir "dist\ipa"

echo [APK] Latest EAS android build...
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli build:list --platform android --limit 1 --json --non-interactive > "%TEMP%\eas-pub-apk.json" 2>nul
python -c "import json,urllib.request,os; raw=open(os.environ['TEMP']+r'\\eas-pub-apk.json',encoding='utf-8').read(); i=raw.find('['); data=json.loads(raw[i:] if i>=0 else raw); b=data[0] if isinstance(data,list) else data; url=(b.get('artifacts') or {}).get('buildUrl') or (b.get('artifacts') or {}).get('applicationArchiveUrl'); print('status', b.get('status'));
assert b.get('status')=='FINISHED' and url; out=r'dist\\apk\\CommanderPro.apk'; open(out,'wb').write(urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=300).read()); print('apk', os.path.getsize(out))"
if errorlevel 1 echo WARN: APK download failed

echo.
echo [IPA] Latest successful ios-build.yml run...
for /f "delims=" %%R in ('gh run list --workflow=ios-build.yml --status success --limit 1 --json databaseId -q ".[0].databaseId" 2^>nul') do set "RUN_ID=%%R"
if "!RUN_ID!"=="" (
  echo WARN: no successful iOS run found
) else (
  set "TMPDIR=%TEMP%\commander-ipa-pub-!RUN_ID!"
  if exist "!TMPDIR!" rmdir /s /q "!TMPDIR!"
  mkdir "!TMPDIR!"
  gh run download !RUN_ID! -D "!TMPDIR!" -n ipa
  for /r "!TMPDIR!" %%F in (*.ipa) do (
    copy /y "%%F" "dist\ipa\CommanderPro.ipa" >nul
    echo ipa copied
    goto :ipa_done
  )
  echo WARN: no ipa artifact
)
:ipa_done

echo.
echo Files:
dir /b dist\apk dist\ipa 2>nul
echo.
echo Start scripts\start-download-server.bat if not running.
echo.
pause
endlocal
exit /b 0

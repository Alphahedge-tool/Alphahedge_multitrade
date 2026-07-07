@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO_URL=https://github.com/Alphahedge-tool/Alphahedge_multitrade.git"
set "REPO_NAME=Alphahedge_multitrade"

if /I "%~1"=="--help" goto :help
if /I "%~1"=="/?" goto :help

echo.
echo AlphaHedge Multitrade installer and runner
echo ------------------------------------------
echo This script will clone/update the project, install required tools/packages,
echo create a local .env if needed, and run: npm run admin
echo.

call :ensureTool git "Git.Git" "Git"
if errorlevel 1 goto :fail

call :ensureTool node "OpenJS.NodeJS.LTS" "Node.js LTS"
if errorlevel 1 goto :fail

call :ensureTool npm "OpenJS.NodeJS.LTS" "npm"
if errorlevel 1 goto :fail

call :ensureTool python "Python.Python.3.12" "Python 3"
if errorlevel 1 goto :fail

call :ensureTool go "GoLang.Go" "Go"
if errorlevel 1 goto :fail

call :ensureChrome
if errorlevel 1 goto :fail

set "DEFAULT_PARENT=%USERPROFILE%\Alphahedge"
echo.
set /p "INSTALL_PARENT=Install parent folder [%DEFAULT_PARENT%]: "
if "%INSTALL_PARENT%"=="" set "INSTALL_PARENT=%DEFAULT_PARENT%"
set "INSTALL_PARENT=%INSTALL_PARENT:"=%"
set "APP_DIR=%INSTALL_PARENT%\%REPO_NAME%"

if not exist "%INSTALL_PARENT%" (
  echo Creating "%INSTALL_PARENT%"...
  mkdir "%INSTALL_PARENT%" || goto :fail
)

if exist "%APP_DIR%\.git" (
  echo.
  echo Repository already exists. Updating "%APP_DIR%"...
  pushd "%APP_DIR%" || goto :fail
  git pull --ff-only || goto :failPopd
  popd
) else (
  if exist "%APP_DIR%\*" (
    echo.
    echo ERROR: "%APP_DIR%" already exists but is not a Git repo.
    echo Choose a different parent folder or move/delete that folder.
    goto :fail
  )
  echo.
  echo Cloning repository into "%APP_DIR%"...
  git clone "%REPO_URL%" "%APP_DIR%" || goto :fail
)

cd /d "%APP_DIR%" || goto :fail

echo.
echo Installing Node packages...
npm install || goto :fail

if exist "go-backend\scripts\requirements.txt" (
  echo.
  echo Installing Python packages...
  python -m pip install --upgrade pip || goto :fail
  python -m pip install -r "go-backend\scripts\requirements.txt" || goto :fail
)

if exist "go-backend\go.mod" (
  echo.
  echo Downloading Go modules...
  pushd "go-backend" || goto :fail
  go mod download || goto :failPopd
  popd
)

if not exist ".env" (
  echo.
  echo No .env file found. Enter local Supabase values for this PC.
  echo Leave blank only if you want to configure .env manually later.
  set /p "SUPABASE_URL_VALUE=SUPABASE_URL: "
  set /p "SUPABASE_SERVICE_KEY_VALUE=SUPABASE_SERVICE_KEY: "
  (
    echo SUPABASE_URL=!SUPABASE_URL_VALUE!
    echo SUPABASE_SERVICE_KEY=!SUPABASE_SERVICE_KEY_VALUE!
  ) > ".env"
  echo Created "%APP_DIR%\.env"
) else (
  echo.
  echo Existing .env found. Keeping it unchanged.
)

echo.
echo Starting AlphaHedge admin...
echo URL: http://localhost:5173/admin.html
echo Press Ctrl+C to stop both servers.
echo.
npm run admin
goto :done

:ensureTool
where %~1 >nul 2>nul
if not errorlevel 1 (
  echo Found %~3.
  exit /b 0
)

echo.
echo %~3 is missing.
call :installWithWinget "%~2" "%~3"
if errorlevel 1 exit /b 1
call :refreshPath
where %~1 >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: %~3 was installed but is not available in this Command Prompt.
  echo Close this window, open a new Command Prompt, and run this script again.
  exit /b 1
)
exit /b 0

:installWithWinget
where winget >nul 2>nul
if errorlevel 1 (
  echo ERROR: winget is not installed. Install %~2 manually, then run this script again.
  exit /b 1
)
echo Installing %~2 with winget...
winget install --id "%~1" --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo ERROR: winget could not install %~2.
  exit /b 1
)
exit /b 0

:ensureChrome
where chrome >nul 2>nul
if not errorlevel 1 (
  echo Found Google Chrome.
  exit /b 0
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  echo Found Google Chrome.
  exit /b 0
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  echo Found Google Chrome.
  exit /b 0
)
echo.
echo Google Chrome is missing. It is needed for Selenium-based Upstox login.
call :installWithWinget "Google.Chrome" "Google Chrome"
exit /b %errorlevel%

:refreshPath
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs;%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;%ProgramFiles%\Go\bin"
exit /b 0

:failPopd
popd

:fail
echo.
echo Setup failed. Fix the error above and run install-alphahedge.cmd again.
exit /b 1

:help
echo Usage: install-alphahedge.cmd
echo.
echo Prompts for a parent folder, clones/updates:
echo   %REPO_URL%
echo.
echo Then installs dependencies and starts:
echo   npm run admin
exit /b 0

:done
endlocal

@echo off
setlocal
title DOCA Stream Overlays

:: Get the directory where this script lives
set "BASE=%~dp0"
if "%BASE:~-1%"=="" set "BASE=%BASE:~0,-1%"
cd /d "%BASE%"

:: 1. Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed or not found in your PATH.
    echo Please install Node.js from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

:: 2. Check for required server files inside the public folder
if not exist "public\goal-server.js" (
    echo ERROR: public\goal-server.js is missing.
    pause
    exit /b 1
)
if not exist "public\names-server.js" (
    echo ERROR: public\names-server.js is missing.
    pause
    exit /b 1
)

:: 3. Automatically install dependencies inside the public folder if missing
if not exist "public\node_modules" (
    echo First-time setup: Installing required packages... Please wait.
    cd /d "%BASE%\public"
    call npm install express socket.io-client dotenv >nul 2>&1
    cd /d "%BASE%"
)

:: 4. Stop any old running instances of our servers to avoid port conflicts
for %%P in (3000 3001) do (
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
        taskkill /F /PID %%A >nul 2>&1
    )
)

timeout /t 1 /nobreak >nul

:: 5. Start Goal Server from inside the public folder working directory
powershell.exe -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'goal-server.js' -WorkingDirectory '%BASE%\public' -WindowStyle Hidden"

:: 6. Start Names Server from inside the public folder working directory
powershell.exe -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'names-server.js' -WorkingDirectory '%BASE%\public' -WindowStyle Hidden"

:: 7. Give servers a brief moment to spin up, then open the browser app
timeout /t 2 /nobreak >nul
start "" http://localhost:3000/admin

endlocal
exit /b 0
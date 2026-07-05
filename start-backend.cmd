@echo off
REM ============================================================================
REM  Alphahedge backend launcher (Supabase-enabled)
REM  Double-click this file, or run it from a terminal. It:
REM    1. sets the Supabase env vars the Go backend reads,
REM    2. rebuilds the binary so the latest code is used,
REM    3. starts the server on http://localhost:3001
REM  Close the window (or Ctrl+C) to stop the server.
REM ============================================================================

REM --- Supabase credentials (the Go backend reads these from the environment) ---
if not defined SUPABASE_URL set "SUPABASE_URL=https://your-project.supabase.co"
if not defined SUPABASE_SERVICE_KEY set "SUPABASE_SERVICE_KEY=your-service-role-key"

REM --- Nubra REST host: PROD (real accounts). Change to https://uatapi.nubra.io for UAT. ---
set "NUBRA_BASE_URL=https://api.nubra.io"

cd /d "%~dp0go-backend"

echo(
echo === Building backend (latest code) ===
go build -o angelone-backend.exe .
if errorlevel 1 (
  echo(
  echo BUILD FAILED - fix the errors above, then run this again.
  pause
  exit /b 1
)

echo Build OK.
echo(
echo === Starting backend with Supabase enabled ===
echo   SUPABASE_URL = %SUPABASE_URL%
echo   Panel:  http://localhost:3001
echo   Verify: http://localhost:3001/api/accounts  (should show "enabled":true)
echo(
echo Press Ctrl+C to stop.
echo(

angelone-backend.exe

echo(
echo Server stopped.
pause

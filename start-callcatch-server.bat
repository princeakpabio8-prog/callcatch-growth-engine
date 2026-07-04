@echo off
cd /d "%~dp0"
echo Starting CallCatch AI Growth Engine server...
echo.
echo Keep this window open while using the dashboard.
echo App: http://127.0.0.1:8787/
echo Server: http://127.0.0.1:8787
echo Health: http://127.0.0.1:8787/health
echo Network check: http://127.0.0.1:8787/api/network-check
echo.
start "" "http://127.0.0.1:8787/"
node .\callcatch-lead-server.js
pause

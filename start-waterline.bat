@echo off
cd /d "%~dp0"
echo Starting Waterline... leave this window open.
start "" http://localhost:3000
npm start
pause

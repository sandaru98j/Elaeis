@echo off
title Elaeis — Palm Basis Crop Monitoring System
echo Starting Elaeis at http://127.0.0.1:8080 ...
start http://127.0.0.1:8080
python "%~dp0server.py"
pause

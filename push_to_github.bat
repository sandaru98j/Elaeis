@echo off
title Push Elaeis to GitHub
cd /d "C:\Users\Rue\Projects\Elaeis"
echo Pushing Elaeis to https://github.com/sandaru98j/Elaeis.git ...
echo (If a GitHub Sign-In window appears, click "Sign in with your browser")
git push -u origin main
echo.
echo Done!
pause

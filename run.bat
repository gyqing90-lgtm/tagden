@echo off
setlocal
title 物种标注工坊

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

rem 已经在跑就直接开浏览器，别再来一个进程抢 7801
netstat -an | findstr ":7801" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo   程序已经在运行了，正在打开浏览器...
  start "" http://127.0.0.1:7801
  exit /b 0
)

echo.
echo   物种标注工坊 · 正在启动...
echo   浏览器会自动打开；关掉这个黑窗口就是退出程序。
echo.

node server.js

echo.
echo   程序已退出。
echo.
pause
exit /b 0

:nonode
echo.
echo   没找到 Node.js。先装一个再双击这个文件：
echo   https://nodejs.org  （选 LTS 版，一路下一步）
echo.
pause
exit /b 1

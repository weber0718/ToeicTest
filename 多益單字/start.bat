@echo off
chcp 65001 >nul
title TOEIC Vocab Master - 多益單字測驗與錯題本系統

echo ====================================================
echo 🎯 正在啟動 TOEIC Vocab Master 伺服器...
echo ====================================================

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [系統] 偵測到 Node.js 環境，使用 node server.js 啟動後端資料庫服務...
    start "" "http://localhost:3000"
    node server.js
) else (
    echo [系統] 未在 PATH 偵測到 Node.js，自動切換為 Windows 內建本地端 REST API 伺服器 ^(server.ps1^)...
    echo [系統] 資料將即時儲存於 data\db.json 伺服器資料庫中。
    start "" "http://localhost:3000"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
)

pause

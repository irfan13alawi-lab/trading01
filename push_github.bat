@echo off
echo ================================================
echo   Nexora V4 - Push ke GitHub
echo   Repo: github.com/irfan13alawi-lab/trading01
echo ================================================
echo.

set GITHUB_USER=irfan13alawi-lab
set REPO_NAME=trading01
set REPO_URL=https://github.com/%GITHUB_USER%/%REPO_NAME%.git
set GIT_EMAIL=limatrade55g@gmail.com
set GIT_NAME=irfan13alawi-lab

:: Masuk ke folder ini
cd /d "%~dp0"
echo Folder: %CD%
echo.

:: Cek git installed
git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git belum terinstall!
    echo Download di: https://git-scm.com/download/win
    pause
    exit /b 1
)

:: Set identity (wajib untuk commit)
echo Setting git identity...
git config --global user.email "%GIT_EMAIL%"
git config --global user.name "%GIT_NAME%"

:: Init repo kalau belum ada
if not exist ".git" (
    echo Init repo baru...
    git init
    git branch -M main
)

:: Set remote
git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%

:: Add dan commit
echo.
echo Menambahkan file...
git add Nexora_V4_Clean.html README.md .gitignore push_github.bat

echo Commit...
git commit -m "Nexora V4 update - %DATE%"

:: Push
echo Push ke GitHub...
echo.
echo Kalau minta password: masukkan Personal Access Token
echo Buat di: github.com/settings/tokens (centang 'repo')
echo.
git push -u origin main

echo.
echo ================================================
if %ERRORLEVEL%==0 (
    echo   SUKSES!
    echo   https://github.com/%GITHUB_USER%/%REPO_NAME%
) else (
    echo   Gagal push. Cek:
    echo   1. Token sudah benar? github.com/settings/tokens
    echo   2. Repo 'trading01' sudah ada di GitHub?
)
echo ================================================
pause

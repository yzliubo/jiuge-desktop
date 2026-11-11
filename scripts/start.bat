@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

rem 某些宿主（如基于 Electron 的工具）会注入 ELECTRON_RUN_AS_NODE=1，导致 electron 以纯 Node 模式跑；
rem 这里显式清空，保证双击时进入正常的 Electron 主进程。
set "ELECTRON_RUN_AS_NODE="

echo 九格手记 Windows 桌面版 · 正在启动...

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo [提示] 未检测到 Electron 运行时，尚未安装依赖。
  echo 请先在本目录执行：npm install
  echo 若下载超时，可先执行 scripts\package-win.bat 设置国内镜像，或手工解压 electron-v*-win32-x64.zip 到 node_modules\electron\dist\
  echo.
  pause
  exit /b 1
)

rem 用最小化的控制台拉起 npm start，避免长时间残留黑窗；Electron 自带 GUI 窗口。
start "" /min cmd /c "npm start"
endlocal

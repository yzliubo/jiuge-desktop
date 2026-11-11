@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

rem 国内镜像：Electron 二进制与打包期 nsis/winCodeSign 资源（架构 §8.2）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo 九格手记 Windows 桌面版 · 开始打包
echo Electron 镜像：%ELECTRON_MIRROR%
echo 打包资源镜像：%ELECTRON_BUILDER_BINARIES_MIRROR%
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [步骤 1/2] 安装依赖（electron + electron-builder）...
  call npm install
  if errorlevel 1 (
    echo.
    echo [失败] npm install 未成功，已中止打包。请检查网络或改用 npm install --ignore-scripts 后手工解压 Electron。
    echo.
    pause
    exit /b 1
  )
) else (
  echo [步骤 1/2] Electron 运行时已就位，跳过安装。
)

echo.
echo [步骤 2/2] 产出 portable 免安装 exe + NSIS 安装版...
call npm run dist
if errorlevel 1 (
  echo.
  echo [失败] 打包未成功。若只是 nsis/winCodeSign 下载超时，可改跑：npx electron-builder --win --x64 --dir
  echo 交付免安装目录后仍可用 scripts\start.bat 启动（L1 降级口径）。
  echo.
  pause
  exit /b 1
)

echo.
echo 打包完成，产物在 build\ 目录。
echo 优先交付：build\九格手记-便携版.exe
echo.
pause
endlocal

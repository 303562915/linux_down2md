@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM Linux.do HTML → Obsidian Markdown
REM 用法:
REM   convert.bat 文件.html
REM   convert.bat *.html
REM   convert.bat 文件.html --extract-images assets
REM   convert.bat 文件.html --emoji-text

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 python，请先安装 Python 3 并加入 PATH
  exit /b 1
)

python -c "import bs4" 2>nul
if errorlevel 1 (
  echo 正在安装依赖 beautifulsoup4 ...
  python -m pip install -r requirements.txt
)

if "%~1"=="" (
  echo 用法: convert.bat 导出的.html [更多.html] [可选参数]
  echo.
  echo 可选参数:
  echo   -o out.md                 指定输出文件
  echo   -d md_out                 批量输出到目录
  echo   --extract-images assets   图片拆成文件（适合超大图）
  echo   --emoji-text              emoji 用 :name: 文本，减小体积
  echo   --no-base64               不内嵌 base64，改用原图 URL
  echo.
  echo 示例:
  echo   convert.bat linux-do-topic-*.html --emoji-text
  echo   convert.bat post.html --extract-images assets
  exit /b 0
)

python "%~dp0html2md.py" %*
exit /b %ERRORLEVEL%

# Linux.do → Obsidian 笔记工具集

两套方案，按需使用：

## 1. 浏览器插件（推荐）：直接导出笔记

目录：[`extension/`](./extension/)

在 linux.do 主题页一键导出 Markdown（默认 HTML 转换，也可直取论坛 Raw Markdown；图片可 base64 / WebDAV），直接丢进 Obsidian。

```
1. Chrome/Edge 打开 扩展 → 开发者模式
2. 「加载已解压的扩展程序」→ 选 extension 文件夹
3. 点击扩展图标 → 右侧打开侧边栏
4. 打开主题帖 → 在侧边栏导出
```

详见 [extension/README.md](./extension/README.md)

## 2. 本地脚本：HTML 转 MD

若你已有油猴导出的 HTML：

```bat
pip install -r requirements.txt
convert.bat 导出.html --emoji-text
python html2md.py 导出.html -o 笔记.md
```

## 文件说明

| 路径 | 作用 |
|------|------|
| `extension/` | Chrome/Edge MV3 扩展 |
| `html2md.py` | HTML → Markdown 转换器 |
| `convert.bat` | Windows 一键转换 |
| `linux-do-topic-*.html` | 示例导出 HTML |
| `772045-*.md` | 示例转换结果 |

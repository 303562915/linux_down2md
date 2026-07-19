# L站笔记导出（浏览器插件）

一键把 [linux.do](https://linux.do) 主题导出为 **Obsidian 可直接导入** 的 Markdown 笔记。  
正文图片默认转 **base64 内嵌**，离线也能看。

## 功能

- 工具栏弹窗：全部楼层 / **仅贴主** / 仅一楼 / 楼层范围
- 页面右下角浮动按钮：当前帖一键导出（沿用弹窗里保存的范围选项）
- 自动分页拉取全部 `post_stream` 楼层
- HTML → Markdown（标题、列表、引用、代码、表格、details 折叠）
- 图片 base64；emoji 可改成 `:name:`
- YAML frontmatter（title / source / tags / topic_id）

## 安装（Chrome / Edge / 国内 Chromium 内核）

1. 打开扩展管理页  
   - Chrome：`chrome://extensions`  
   - Edge：`edge://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本目录：  
   `...\linux_down\extension`
5. 固定扩展图标，方便使用

> 需要 **Chrome 114+** / **Edge 114+**（Side Panel 侧边栏 API）

## 使用

1. 先登录 linux.do（导出需站点 cookie，才能读权限贴/完整内容）
2. 打开任意主题帖，例如：  
   `https://linux.do/t/slug/772045`
3. **点击扩展图标** → 浏览器右侧打开 **侧边栏**（不是小弹窗）
4. 在侧边栏里选范围 / 图片模式 / WebDAV → **导出 Markdown 笔记**
5. 也可点页面右下角浮动按钮一键导出（沿用侧边栏里保存的设置）

侧边栏会随你切换标签页自动刷新当前主题信息；也可点标题旁 **刷新**。

### 导出范围

| 模式 | 含义 |
|------|------|
| 全部 | 主题内所有楼层 |
| **仅贴主** | 贴主发过的全部楼层（一楼 + 贴主后续回复） |
| 仅一楼 | 只导出第 1 楼 |
| 范围 | 按楼层号区间导出 |

文件名会带后缀，例如：`772045-标题-贴主.md`

### Obsidian 适配

| 项 | 默认 | 说明 |
|----|------|------|
| 楼层标题 | `####` | 不再用 `##`，大纲不会被楼层刷屏 |
| 正文标题 | 再下沉 3 级 | 正文 `h1`→`####`，`h2`→`#####` |
| 锚点 ID | 自动清理 | 去掉 `#p-18018459-h-4` 这类 Discourse 锚点 |
| 紧凑楼层 | 可选 | 楼层改成加粗，完全不进大纲 |

### 自定义保存路径

浏览器扩展**不能**直接写任意盘符（安全限制），但可以写到：

```text
浏览器「下载」目录 / 你填的子路径 / 文件名.md
```

**推荐做法：**

1. 把 Chrome/Edge 下载目录设成你的 vault，例如  
   `D:\Obsidian\MyVault`
2. 插件里「Obsidian 笔记路径」填子文件夹，例如：  
   `LinuxDo` 或 `论坛/linux.do`
3. 导出后文件出现在：  
   `D:\Obsidian\MyVault\LinuxDo\772045-标题.md`

也可以勾选「每次弹出另存为」，手动选 vault 任意位置。

### 图片处理

| 模式 | 说明 |
|------|------|
| **L站链接**（默认） | 保留 linux.do / CDN 原图地址，导出快 |
| **Base64** | 图嵌在 md 里，离线可看，体积大（不推荐大帖） |
| **WebDAV** | 上传到坚果云等，md 写文件链接 |

#### WebDAV（坚果云）

1. 服务器默认已填：`https://dav.jianguoyun.com/dav/`
2. 用户名 / **应用密码**
3. **同步根目录** → 点「浏览选择」进入网盘点选（可进子目录）
4. **图片保存文件夹** → 再点「浏览选择」点进子文件夹后「选中此目录」
5. 可在浏览器里 **新建子文件夹**，不必手打路径
6. 笔记链接推荐「相对路径」

导出后：

```markdown
![截图](attachments/a1b2c3d4e5f6.png)
```

请保证该文件夹已同步到 Obsidian vault。首次会申请 WebDAV 域名权限。

### 笔记路径（可选）

侧边栏可勾选「开启笔记下载路径」；关闭则走浏览器默认下载/另存为。

### 推荐选项

| 选项 | 建议 |
|------|------|
| 图片 | L站链接（默认）/ WebDAV（要本地图） |
| Emoji 用文本 | 开 |
| YAML frontmatter | 开 |
| 楼层标题级别 | `####` |

## 目录结构

```
extension/
  manifest.json         # MV3 清单
  background.js         # 侧边栏 + 下载 + 跨域代理
  sidepanel.html/js/css # 侧边栏 UI（主界面）
  content.js/css        # 页面浮动按钮
  lib/
    discourse.js        # 拉主题 API
    html2md.js          # cooked HTML → MD
    export.js           # 组装笔记
    webdav.js           # WebDAV 上传
  icons/
```

## 输出示例

```markdown
---
title: "主题标题"
source: https://linux.do/t/topic/772045
topic_id: 772045
tags:
  - 软件开发
site: linux.do
---

# 主题标题

## #1 作者 · 2025-07-01 12:00

正文……

![截图](data:image/png;base64,...)
```

## 权限说明

- `downloads`：保存 `.md`
- `storage`：记住选项
- `host_permissions`：读取 linux.do API 与图片 CDN

仅用于你自己收藏笔记，请遵守站点规则与版权。

## 排查

| 现象 | 处理 |
|------|------|
| 弹窗提示不是主题页 | 确认 URL 含 `/t/.../数字` |
| 导出失败 403 | 先登录 linux.do 再试 |
| 图片是链接不是图 | 开启「图片转 base64」，或检查 CDN 是否可访问 |
| 浮动按钮没有 | 刷新主题页；确认扩展已启用 |
| 修改代码不生效 | 到扩展页点「重新加载」 |

## 与本地脚本关系

仓库根目录还有 `html2md.py`：把已导出的 HTML 文件转 MD。  
本扩展则是 **在浏览器里直接导出**，无需先存 HTML。

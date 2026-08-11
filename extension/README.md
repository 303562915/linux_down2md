# L站笔记导出（浏览器插件）

一键把 [linux.do](https://linux.do) 主题导出为 **Obsidian 可直接导入** 的 Markdown 笔记。  
正文图片默认转 **base64 内嵌**，离线也能看。  

## 1.7.9 更新

- Raw 全量导出仅读取 `/raw/{topicId}?page=N`，不再按 10 层请求帖子索引或先读取主题 JSON。
- Raw 楼层标题中的作者直接链接到个人页；引用、相对链接和图片地址会规范化。
- `upload://` 图片短码在当前已登录论坛页中一次性解析为真实 CDN 地址，避免后台请求缺少 CSRF 而返回 403。
- Raw 请求增加超时与限流提示；已保存的本地文件夹会复用，不会每次要求重新选择。

## 功能

- 侧边栏：全部楼层 / **仅贴主** / 仅一楼 / 楼层范围
- 自动分页拉取全部 `post_stream` 楼层
- 正文来源可选：HTML → Markdown（默认）或论坛 Raw Markdown（不经过 HTML 转换）
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
3. **点击扩展图标** → 浏览器右侧打开 **侧边栏**
4. 在侧边栏里选范围 / 正文来源 / 图片模式 / WebDAV → **导出笔记**

侧边栏会随你切换标签页自动刷新当前主题信息；也可点标题旁 **刷新**。

### 导出范围

| 模式 | 含义 |
|------|------|
| 全部 | 主题内所有楼层 |
| **仅贴主** | 贴主发过的全部楼层（一楼 + 贴主后续回复） |
| 仅一楼 | 只导出第 1 楼 |
| 范围 | 按楼层号区间导出 |

文件名会带后缀，例如：`772045-标题-贴主.md`

### 正文来源

| 模式 | 说明 |
|------|------|
| **HTML 转换**（默认） | 使用 Discourse 的 cooked HTML，再转换为适合 Obsidian 的 Markdown；正文标题会按设置下沉。 |
| **Raw Markdown** | 全帖按论坛 `/raw/{topicId}?page=N` 分页读取原文，不经过 HTML 转换，可保留作者原始 Markdown。 |

Raw 的全部模式只按 `page=1, 2, 3…` 取原文，不请求主题 JSON 或按 10 层批量拉取帖子索引；遇到空页或重复页即停止。Raw 内的 `用户名 | 时间 | #楼层` 会转换为带个人页链接的楼层标题。Raw 里的 `upload://短码.扩展名` 会在全部页面读取后一次性经 Discourse 上传查询接口解析为真实 CDN 图片地址；`/original/...`、`/optimized/...` 图片会使用 `https://cdn3.ldstatic.com` 域名。仅一楼和精确楼层范围只请求所选楼层；仅贴主模式需要先读楼层索引，才能筛出贴主回复。选择 Base64 或 WebDAV 时会改写 Markdown 中的图片链接。

Raw 分页请求间保留短间隔；遇到论坛限流会等待后重试，请保持侧边栏打开直到完成。

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
启用本地文件夹但尚未选择路径时，点击「导出笔记」会先打开文件夹选择器，再开始导出。

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
    export.js           # HTML / Raw 正文与笔记组装
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

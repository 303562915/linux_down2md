#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Linux.do 导出 HTML → Obsidian Markdown 转换器

支持：
- L2do-export / 油猴导出的论坛主题 HTML
- 正文图片保留 base64（可直接导入 Obsidian）
- 可选：把 base64 拆成附件文件（更适合超大图）
- details/summary、引用、代码、列表、链接、emoji

用法：
  python html2md.py input.html
  python html2md.py input.html -o out.md
  python html2md.py input.html --extract-images ./assets
  python html2md.py *.html -d ./md_out
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html as html_lib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import unquote

try:
    from bs4 import BeautifulSoup, NavigableString, Tag
except ImportError:
    print("缺少依赖 BeautifulSoup，正在尝试安装...", file=sys.stderr)
    import subprocess

    subprocess.check_call([sys.executable, "-m", "pip", "install", "beautifulsoup4", "-q"])
    from bs4 import BeautifulSoup, NavigableString, Tag


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class Post:
    number: str = ""
    author: str = ""
    author_url: str = ""
    date: str = ""
    avatar_src: str = ""
    reply_to: str = ""
    content_md: str = ""


@dataclass
class Topic:
    title: str = ""
    category: str = ""
    tags: List[str] = field(default_factory=list)
    topic_id: str = ""
    url: str = ""
    posts_count: str = ""
    exported_at: str = ""
    posts: List[Post] = field(default_factory=list)


# ---------------------------------------------------------------------------
# HTML → Markdown 节点转换
# ---------------------------------------------------------------------------

BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "table", "tr",
    "hr", "details", "summary", "aside", "figure", "figcaption",
}

SKIP_TAGS = {"script", "style", "noscript", "svg", "meta", "link"}


class HtmlToMarkdown:
    def __init__(
        self,
        *,
        keep_base64: bool = True,
        extract_dir: Optional[Path] = None,
        skip_avatars: bool = True,
        skip_emoji_img: bool = False,
        image_prefix: str = "",
    ):
        self.keep_base64 = keep_base64
        self.extract_dir = extract_dir
        self.skip_avatars = skip_avatars
        self.skip_emoji_img = skip_emoji_img
        self.image_prefix = image_prefix  # 相对 md 的路径前缀，如 assets/
        self._img_index = 0
        self.saved_images: List[Path] = []

    # ---- public ----

    def convert_fragment(self, node) -> str:
        md = self._walk(node)
        # 清理空白
        md = re.sub(r"[ \t]+\n", "\n", md)
        md = re.sub(r"\n[ \t]+", "\n", md)
        md = re.sub(r"[ \t]{2,}", " ", md)
        md = re.sub(r"\n{3,}", "\n\n", md)
        return md.strip()

    # ---- image handling ----

    def _handle_image(self, img: Tag) -> str:
        classes = set(img.get("class") or [])
        src = (img.get("src") or "").strip()
        alt = (img.get("alt") or img.get("title") or "").strip()
        title = (img.get("title") or "").strip()

        # 头像
        if self.skip_avatars and ("avatar" in classes or "avatar" in (img.get("class") or [])):
            return ""

        # emoji：优先用 :name: 文本，体积更小
        if "emoji" in classes or (title.startswith(":") and title.endswith(":")):
            if self.skip_emoji_img or not src:
                return title or alt or ""
            # 小 emoji 仍可内嵌；太大则退回文本
            if src.startswith("data:") and len(src) > 50_000:
                return title or alt or ""

        if not src:
            return ""

        # lightbox 外层有原图链接时，src 已是 base64 内嵌，优先用 src
        final_src = src
        if self.extract_dir and src.startswith("data:image"):
            final_src = self._extract_data_image(src, alt)
        elif not self.keep_base64 and src.startswith("data:image"):
            # 不保留 base64 时，尝试 lightbox 原始 URL
            parent_a = img.find_parent("a", class_=re.compile(r"lightbox"))
            if parent_a and parent_a.get("href"):
                final_src = parent_a["href"]
            else:
                return f"[图片: {alt}]" if alt else "[图片]"

        # markdown 图片
        alt_esc = alt.replace("]", "\\]")
        if title and not title.startswith(":"):
            return f'![{alt_esc}]({final_src} "{title}")'
        return f"![{alt_esc}]({final_src})"

    def _extract_data_image(self, data_url: str, alt: str = "") -> str:
        m = re.match(r"data:image/([a-zA-Z0-9.+-]+);base64,(.+)", data_url, re.S)
        if not m:
            return data_url
        ext = m.group(1).lower().split("+")[0]
        if ext == "jpeg":
            ext = "jpg"
        raw_b64 = re.sub(r"\s+", "", m.group(2))
        try:
            data = base64.b64decode(raw_b64)
        except Exception:
            return data_url

        digest = hashlib.sha1(data).hexdigest()[:12]
        safe_alt = re.sub(r"[^\w一-鿿-]+", "_", alt)[:40].strip("_") or "img"
        self._img_index += 1
        name = f"{self._img_index:03d}_{safe_alt}_{digest}.{ext}"

        self.extract_dir.mkdir(parents=True, exist_ok=True)
        path = self.extract_dir / name
        if not path.exists():
            path.write_bytes(data)
        self.saved_images.append(path)

        if self.image_prefix:
            return f"{self.image_prefix.rstrip('/')}/{name}"
        return name

    # ---- walk ----

    def _walk(self, node) -> str:
        if node is None:
            return ""
        if isinstance(node, NavigableString):
            text = str(node)
            # 保留有意义空白，折叠纯空白为单空格（块级边界另处理）
            if not text.strip():
                return " " if " " in text or "\n" in text else ""
            return html_lib.unescape(text)

        if not isinstance(node, Tag):
            return ""

        name = node.name.lower()
        if name in SKIP_TAGS:
            return ""

        # 跳过 lightbox meta（文件名/尺寸条）
        classes = set(node.get("class") or [])
        if "meta" in classes and node.find_parent(class_="lightbox-wrapper"):
            return ""
        if "lightbox-wrapper" in classes:
            # 只取里面的 img
            img = node.find("img")
            return self._handle_image(img) if img else self._children(node)

        if name == "img":
            return self._handle_image(node)

        if name == "br":
            return "\n"

        if name == "hr":
            return "\n\n---\n\n"

        if name in {"strong", "b"}:
            inner = self._inline_children(node).strip()
            return f"**{inner}**" if inner else ""

        if name in {"em", "i"}:
            inner = self._inline_children(node).strip()
            return f"*{inner}*" if inner else ""

        if name == "code" and node.parent and node.parent.name != "pre":
            inner = node.get_text()
            return f"`{inner}`"

        if name == "pre":
            code = node.get_text()
            lang = ""
            code_el = node.find("code")
            if code_el:
                cls = " ".join(code_el.get("class") or [])
                m = re.search(r"language-([\w+-]+)", cls)
                if m:
                    lang = m.group(1)
                code = code_el.get_text()
            return f"\n\n```{lang}\n{code.rstrip()}\n```\n\n"

        if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            # 帖子本身用 ##，正文标题整体下沉一级，避免层级冲突
            level = min(int(name[1]) + 1, 6)
            inner = self._inline_children(node).strip()
            return f"\n\n{'#' * level} {inner}\n\n"

        if name == "a":
            href = (node.get("href") or "").strip()
            # 纯 lightbox 链接：内容是图，由 img 处理
            if "lightbox" in classes:
                return self._children(node)
            inner = self._inline_children(node).strip()
            if not href:
                return inner
            if not inner:
                inner = href
            # 忽略 javascript:
            if href.lower().startswith("javascript:"):
                return inner
            return f"[{inner}]({href})"

        if name == "blockquote" or (name == "aside" and "quote" in classes):
            # Discourse quote
            header = node.find(class_="quote-header") or node.find(class_="title")
            body = node
            parts = []
            if header:
                ht = self._children(header).strip()
                if ht:
                    parts.append(f"**{ht}**")
                # 避免 header 重复
                header.extract()
            inner = self._children(body).strip()
            if inner:
                parts.append(inner)
            quoted = "\n".join(parts)
            lines = [f"> {ln}" if ln.strip() else ">" for ln in quoted.splitlines()]
            return "\n\n" + "\n".join(lines) + "\n\n"

        if name == "ul":
            items = []
            for li in node.find_all("li", recursive=False):
                items.append(f"- {self._children(li).strip()}")
            return "\n\n" + "\n".join(items) + "\n\n"

        if name == "ol":
            items = []
            for i, li in enumerate(node.find_all("li", recursive=False), 1):
                items.append(f"{i}. {self._children(li).strip()}")
            return "\n\n" + "\n".join(items) + "\n\n"

        if name == "li":
            return self._children(node).strip()

        if name == "details":
            summary = node.find("summary")
            summary_text = self._children(summary).strip() if summary else "详情"
            # 克隆处理：去掉 summary 后转正文
            clone_parts = []
            for child in node.children:
                if isinstance(child, Tag) and child.name == "summary":
                    continue
                clone_parts.append(self._walk(child))
            body = "".join(clone_parts).strip()
            # Obsidian 可折叠 callout
            body_lines = body.splitlines() if body else []
            folded = "\n".join(f"> {ln}" if ln.strip() else ">" for ln in body_lines)
            return f"\n\n> [!note]- {summary_text}\n{folded}\n\n"

        if name == "summary":
            return self._children(node).strip()

        if name == "table":
            return self._table(node)

        if name == "p":
            inner = self._children(node).strip()
            # 去掉段落内部因 br 产生的尾随空白行
            inner = re.sub(r"[ \t]+\n", "\n", inner)
            inner = re.sub(r"\n{3,}", "\n\n", inner)
            return f"\n\n{inner}\n\n" if inner else ""

        if name == "span":
            return self._children(node)

        # 默认：块级包一层换行，行内直接拼
        inner = self._children(node)
        if name in BLOCK_TAGS:
            inner = inner.strip()
            return f"\n\n{inner}\n\n" if inner else ""
        return inner

    def _children(self, node: Tag) -> str:
        return "".join(self._walk(c) for c in node.children)

    def _inline_children(self, node: Tag) -> str:
        """行内元素：折叠换行为空格，避免加粗/链接被拆行。"""
        text = self._children(node)
        text = re.sub(r"\s*\n\s*", " ", text)
        text = re.sub(r"[ \t]{2,}", " ", text)
        return text

    def _table(self, table: Tag) -> str:
        rows = []
        for tr in table.find_all("tr"):
            cells = []
            for cell in tr.find_all(["th", "td"], recursive=False):
                cells.append(self._children(cell).strip().replace("\n", " "))
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        norm = [r + [""] * (width - len(r)) for r in rows]
        lines = [
            "| " + " | ".join(norm[0]) + " |",
            "| " + " | ".join(["---"] * width) + " |",
        ]
        for r in norm[1:]:
            lines.append("| " + " | ".join(r) + " |")
        return "\n\n" + "\n".join(lines) + "\n\n"


# ---------------------------------------------------------------------------
# 解析 Linux.do 导出 HTML
# ---------------------------------------------------------------------------

def parse_topic(html_text: str, converter: HtmlToMarkdown) -> Topic:
    soup = BeautifulSoup(html_text, "html.parser")
    topic = Topic()

    header = soup.select_one("div.header")
    if header:
        h1 = header.find("h1")
        topic.title = h1.get_text(strip=True) if h1 else ""
        cat = header.select_one(".category")
        topic.category = cat.get_text(strip=True) if cat else ""
        topic.tags = [t.get_text(strip=True) for t in header.select(".tag")]
        meta_text = header.get_text(" ", strip=True)
        m = re.search(r"Topic ID:\s*(\d+)", meta_text)
        if m:
            topic.topic_id = m.group(1)
        m = re.search(r"Posts:\s*(\d+)", meta_text)
        if m:
            topic.posts_count = m.group(1)
        a = header.find("a", href=True)
        if a:
            topic.url = a["href"].strip()

    export = soup.select_one(".export-info")
    if export:
        topic.exported_at = export.get_text(" ", strip=True)

    # 无 header 时用 title
    if not topic.title:
        t = soup.find("title")
        if t:
            topic.title = t.get_text(strip=True).split(" - ")[0].strip()

    posts = soup.select("div.post")
    if not posts:
        # 兜底：整页正文
        body = soup.body or soup
        content = body.select_one(".post-content") or body
        p = Post(number="#1", content_md=converter.convert_fragment(content))
        topic.posts.append(p)
        return topic

    for post_el in posts:
        post = Post()
        num = post_el.select_one(".post-number")
        post.number = num.get_text(strip=True) if num else ""
        author = post_el.select_one("a.author-name")
        if author:
            post.author = author.get_text(strip=True)
            post.author_url = author.get("href") or ""
        date = post_el.select_one(".post-date")
        post.date = date.get_text(strip=True) if date else ""
        av = post_el.select_one("img.avatar")
        if av:
            post.avatar_src = av.get("src") or ""
        reply = post_el.select_one(".reply-to")
        if reply:
            post.reply_to = reply.get_text(" ", strip=True)

        content = post_el.select_one(".post-content")
        if content:
            post.content_md = converter.convert_fragment(content)
        else:
            # 去掉 header 后转
            header_el = post_el.select_one(".post-header")
            if header_el:
                header_el.extract()
            post.content_md = converter.convert_fragment(post_el)

        topic.posts.append(post)

    return topic


def topic_to_markdown(topic: Topic, *, include_avatars: bool = False) -> str:
    # YAML frontmatter — Obsidian 友好
    tags = list(topic.tags)
    if topic.category and topic.category not in tags:
        tags = [topic.category] + tags
    # frontmatter tags 清洗
    safe_tags = [re.sub(r"[\[\]#]", "", t).strip() for t in tags if t.strip()]

    fm = ["---", f'title: "{_yaml_escape(topic.title)}"']
    if topic.url:
        fm.append(f"source: {topic.url}")
    if topic.topic_id:
        fm.append(f"topic_id: {topic.topic_id}")
    if topic.category:
        fm.append(f'category: "{_yaml_escape(topic.category)}"')
    if safe_tags:
        fm.append("tags:")
        for t in safe_tags:
            fm.append(f'  - "{_yaml_escape(t)}"')
    fm.append("site: linux.do")
    if topic.exported_at:
        fm.append(f'exported: "{_yaml_escape(topic.exported_at)}"')
    fm.append("---")
    fm.append("")

    lines: List[str] = fm
    lines.append(f"# {topic.title}")
    lines.append("")

    meta_bits = []
    if topic.category:
        meta_bits.append(f"**分类**: {topic.category}")
    if topic.tags:
        meta_bits.append("**标签**: " + " · ".join(f"`{t}`" for t in topic.tags))
    if topic.url:
        meta_bits.append(f"**原帖**: [{topic.url}]({topic.url})")
    if topic.topic_id:
        meta_bits.append(f"**Topic ID**: {topic.topic_id}")
    if meta_bits:
        lines.append("  \n".join(meta_bits))
        lines.append("")
        lines.append("---")
        lines.append("")

    for post in topic.posts:
        head = post.number or ""
        author = post.author or "匿名"
        date = f" · {post.date}" if post.date else ""
        lines.append(f"## {head} {author}{date}".strip())
        lines.append("")
        if post.author_url:
            lines.append(f"*作者*: [{author}]({post.author_url})")
            lines.append("")
        if post.reply_to:
            lines.append(f"> {post.reply_to}")
            lines.append("")
        if post.content_md:
            lines.append(post.content_md)
            lines.append("")
        lines.append("---")
        lines.append("")

    if topic.exported_at:
        lines.append(f"*{topic.exported_at}*")
        lines.append("")

    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def _yaml_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def safe_filename(title: str, fallback: str = "topic") -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip()
    name = re.sub(r"\s+", " ", name)
    name = name.rstrip(". ")
    if not name:
        name = fallback
    # Windows path limit 友好
    if len(name) > 80:
        name = name[:80].rstrip(". ")
    return name


def convert_file(
    input_path: Path,
    output_path: Optional[Path] = None,
    *,
    extract_images: Optional[Path] = None,
    keep_base64: bool = True,
    skip_emoji_img: bool = False,
) -> Path:
    html_text = input_path.read_text(encoding="utf-8", errors="replace")

    image_prefix = ""
    if extract_images is not None:
        # md 与 assets 相对路径
        out = output_path
        if out is None:
            out = input_path.with_suffix(".md")
        try:
            rel = extract_images.resolve().relative_to(out.resolve().parent)
            image_prefix = str(rel).replace("\\", "/")
        except ValueError:
            image_prefix = str(extract_images).replace("\\", "/")

    converter = HtmlToMarkdown(
        keep_base64=keep_base64 if extract_images is None else False,
        extract_dir=extract_images,
        skip_avatars=True,
        skip_emoji_img=skip_emoji_img,
        image_prefix=image_prefix,
    )
    topic = parse_topic(html_text, converter)
    md = topic_to_markdown(topic)

    if output_path is None:
        stem = safe_filename(topic.title or input_path.stem, input_path.stem)
        if topic.topic_id:
            stem = f"{topic.topic_id}-{stem}"
        output_path = input_path.with_name(stem + ".md")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(md, encoding="utf-8")
    return output_path


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="将 Linux.do 导出的 HTML 转为可导入 Obsidian 的 Markdown（图片可保留 base64）"
    )
    parser.add_argument("inputs", nargs="+", help="输入 HTML 文件（支持多个）")
    parser.add_argument("-o", "--output", help="输出 md 路径（仅单文件时使用）")
    parser.add_argument("-d", "--out-dir", help="批量输出目录")
    parser.add_argument(
        "--extract-images",
        metavar="DIR",
        help="把 base64 图片拆到目录（Obidian 附件模式，适合超大图）",
    )
    parser.add_argument(
        "--no-base64",
        action="store_true",
        help="不内嵌 base64，优先使用原图 URL（需联网查看图片）",
    )
    parser.add_argument(
        "--emoji-text",
        action="store_true",
        help="emoji 图片改成 :name: 文本，减小体积",
    )
    args = parser.parse_args(argv)

    inputs = [Path(p) for p in args.inputs]
    for p in inputs:
        if not p.exists():
            print(f"文件不存在: {p}", file=sys.stderr)
            return 1

    if args.output and len(inputs) > 1:
        print("指定 -o 时只能有一个输入文件", file=sys.stderr)
        return 1

    extract_root = Path(args.extract_images) if args.extract_images else None

    for inp in inputs:
        if args.output:
            out = Path(args.output)
        elif args.out_dir:
            # 先用临时 converter 拿 title 不划算，先占位，convert 后再规范
            out = Path(args.out_dir) / (inp.stem + ".md")
        else:
            out = None

        extract_dir = None
        if extract_root is not None:
            if len(inputs) == 1:
                extract_dir = extract_root
            else:
                extract_dir = extract_root / inp.stem

        try:
            result = convert_file(
                inp,
                out,
                extract_images=extract_dir,
                keep_base64=not args.no_base64,
                skip_emoji_img=args.emoji_text,
            )
        except Exception as e:
            print(f"[失败] {inp}: {e}", file=sys.stderr)
            raise

        # 批量时用标题重命名
        if args.out_dir and not args.output:
            html_text = inp.read_text(encoding="utf-8", errors="replace")
            # 轻量取 title
            m = re.search(r"<h1[^>]*>(.*?)</h1>", html_text, re.S)
            title = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else inp.stem
            tid_m = re.search(r"Topic ID:</strong>\s*(\d+)", html_text)
            tid = tid_m.group(1) if tid_m else ""
            stem = safe_filename(title, inp.stem)
            if tid:
                stem = f"{tid}-{stem}"
            final = Path(args.out_dir) / f"{stem}.md"
            if final.resolve() != result.resolve():
                final.parent.mkdir(parents=True, exist_ok=True)
                if final.exists():
                    final.unlink()
                result.replace(final)
                result = final

        size_kb = result.stat().st_size / 1024
        print(f"[完成] {inp.name} → {result} ({size_kb:.1f} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())


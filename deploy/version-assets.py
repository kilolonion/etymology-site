#!/usr/bin/env python3
"""给前端模块的 import 加上 ?v=<版本号>，版本号取自 index.html。

为什么需要：站点在 Cloudflare 后面，CF 会给 .js/.css 盖一层 4 小时的浏览器缓存 TTL
（即使源站发了 no-cache）。如果只给 index.html 里的 main.js 带版本号，
它 import 的 lib.js / views/*.js 还是同一个 URL，用户可能拿到 4 小时前的旧模块，
新旧混搭就会报错、整页只剩一个空壳。

用法：
    python3 deploy/version-assets.py <frontend 目录>
改完的东西不带构建步骤，直接就是 nginx 托管的静态文件。
"""
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "frontend").resolve()
html = (ROOT / "index.html").read_text(encoding="utf-8")
m = re.search(r"/js/main\.js\?v=([\w.-]+)", html)
if not m:
    sys.exit("index.html 里找不到 /js/main.js?v=… 版本号")
VER = m.group(1)

# import ... from "./x.js" / 'x.js' / "./x.js?v=old"
PAT = re.compile(r"""(from\s*["'])([^"']+?\.js)(\?v=[\w.-]+)?(["'])""")


def stamp(match: re.Match) -> str:
    head, path, _old, quote = match.groups()
    return f"{head}{path}?v={VER}{quote}"


changed = 0
for f in sorted((ROOT / "js").rglob("*.js")):
    src = f.read_text(encoding="utf-8")
    out = PAT.sub(stamp, src)
    if out != src:
        f.write_text(out, encoding="utf-8")
        changed += 1
print(f"版本 {VER}：改写了 {changed} 个模块的 import")

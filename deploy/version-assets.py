#!/usr/bin/env python3
"""给前端的 css / js 引用统一打上 ?v=<版本号>。部署脚本（deploy/deploy.sh）会自动调用。

为什么需要：站点在 Cloudflare 后面，CF 会给 .js/.css 盖一层 4 小时的浏览器缓存 TTL
（即使源站发了 no-cache）。如果只给 index.html 里的 main.js 带版本号，
它 import 的 lib.js / views/*.js 还是同一个 URL，用户可能拿到 4 小时前的旧模块，
新旧混搭就会报错、整页只剩一个空壳。所以 index.html 里的 css/js 和所有模块的 import
都要带上同一个版本号。

版本号默认取前端文件内容的哈希：前端没改就不变（浏览器缓存继续有效），改了一个字节就会变，
不用再手动往上推。

用法：
    python3 deploy/version-assets.py <frontend 目录> [--version 版本号]
会直接改写目录里的文件，所以请对**部署用的拷贝**运行，别对仓库里的 frontend/ 运行
（仓库里的 index.html 写的是 ?v=dev）。重复运行结果不变。
"""
import argparse
import hashlib
import re
import sys
from pathlib import Path

# index.html 里指向本站的 css / js：href="/css/style.css" 或 src="/js/main.js?v=旧版本"
HTML_REF = re.compile(r"""((?:href|src)=["'])(/[^"'?]+\.(?:css|js))(\?v=[\w.-]+)?(["'])""")
# 模块里的 import ... from "./x.js" / 'x.js' / "./x.js?v=旧版本"，以及只为副作用的 import "./x.js"
JS_IMPORT = re.compile(r"""((?:from|import)\s*["'])([^"']+?\.js)(\?v=[\w.-]+)?(["'])""")
# 算哈希前先把已有的版本号抹掉，这样对已经打过版本号的目录再算一次，结果也一样
ANY_VER = re.compile(r"\?v=[\w.-]+")


def content_version(root: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        data = f.read_bytes()
        if f.suffix in {".html", ".js"}:
            data = ANY_VER.sub("", data.decode("utf-8")).encode("utf-8")
        h.update(f.relative_to(root).as_posix().encode() + b"\0" + data + b"\0")
    return h.hexdigest()[:10]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("frontend", nargs="?", default="frontend")
    ap.add_argument("--version", help="指定版本号；不填就按文件内容算")
    a = ap.parse_args()

    root = Path(a.frontend).resolve()
    index = root / "index.html"
    if not index.is_file():
        sys.exit(f"{root} 里没有 index.html")
    ver = a.version or content_version(root)
    if not re.fullmatch(r"[\w.-]+", ver):
        sys.exit(f"版本号只能含字母、数字、. _ -：{ver}")

    def stamp(m: re.Match) -> str:
        head, path, _old, quote = m.groups()
        return f"{head}{path}?v={ver}{quote}"

    changed = 0
    for f, pat in [(index, HTML_REF), *((f, JS_IMPORT) for f in sorted((root / "js").rglob("*.js")))]:
        src = f.read_text(encoding="utf-8")
        out = pat.sub(stamp, src)
        if out != src:
            f.write_text(out, encoding="utf-8")
            changed += 1
    if "/js/main.js?v=" not in index.read_text(encoding="utf-8"):
        sys.exit("index.html 里找不到 /js/main.js 的引用，没法打版本号")
    print(ver)
    print(f"版本 {ver}：改写了 {changed} 个文件", file=sys.stderr)


if __name__ == "__main__":
    main()

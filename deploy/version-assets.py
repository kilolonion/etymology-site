#!/usr/bin/env python3
"""给前端的 css / js 引用打上 ?v=<按文件算的内容哈希>，并在 index.html 里写入整体版本号。部署脚本会自动调用。

为什么需要：站点在 Cloudflare 后面，带 ?v= 的 js/css 设成一年 immutable 长缓存；
文件一变地址就变，浏览器和 Service Worker 才会去拿新的，不会新旧混搭白屏。

按文件算（2026-10-21 起）：以前所有文件共用一个版本号，改一个字节，下次打开要把二十几个模块全重新下载一遍，
海外 / 代理慢线路上要好几秒。现在每个文件自己的版本号 = 它自己的内容 + 它 import 的那些文件的版本号
（像 Merkle 树：被依赖的文件变了，引用它的文件地址也跟着变，所以新入口不会拿到旧依赖）。
互相 import 成环的几个文件（强连通分量）合算一个版本号。没改的文件地址不变，缓存继续有效。

整体版本号（所有前端文件内容的哈希）写在 index.html 的 <meta name="ety-version">，
页面靠它判断“线上是不是有新版本”、Service Worker 的地址也带它（只改了 css 也能发现）。

用法：
    python3 deploy/version-assets.py <frontend 目录>
会直接改写目录里的文件，所以请对**部署用的拷贝**运行，别对仓库里的 frontend/ 运行。重复运行结果不变。
标准输出打印整体版本号。
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
ANY_VER = re.compile(r"\?v=[\w.-]+")
META = re.compile(r"""[ \t]*<meta name="ety-version" content="[^"]*">\n?""")


def clean(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix in {".html", ".js"}:
        text = ANY_VER.sub("", data.decode("utf-8"))
        if path.suffix == ".html":
            text = META.sub("", text)
        data = text.encode("utf-8")
    return data


def content_version(root: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        h.update(f.relative_to(root).as_posix().encode() + b"\0" + clean(f) + b"\0")
    return h.hexdigest()[:10]


def resolve(src_file: Path, spec: str, root: Path) -> Path:
    if spec.startswith("/"):
        return (root / spec.lstrip("/")).resolve()
    return (src_file.parent / spec).resolve()


def module_versions(root: Path) -> dict[Path, str]:
    """每个 js 文件的版本号：自身内容 + 依赖的版本号；成环的一组合算一个"""
    files = sorted((root / "js").rglob("*.js"))
    deps = {f.resolve(): [] for f in files}
    for f in files:
        for m in JS_IMPORT.finditer(f.read_text(encoding="utf-8")):
            d = resolve(f, m.group(2), root)
            if d in deps:
                deps[f.resolve()].append(d)

    # Tarjan 求强连通分量，产出顺序正好是“被依赖的先出来”
    index, low, on, stack, sccs = {}, {}, set(), [], []
    counter = [0]

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in deps[v]:
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            sccs.append(sorted(comp))

    sys.setrecursionlimit(10000)
    for v in deps:
        if v not in index:
            strong(v)

    ver: dict[Path, str] = {}
    for comp in sccs:
        h = hashlib.sha256()
        members = set(comp)
        for f in comp:
            h.update(f.relative_to(root.resolve()).as_posix().encode() + b"\0" + clean(f) + b"\0")
        outside = sorted({d for f in comp for d in deps[f] if d not in members})
        for d in outside:
            h.update(d.relative_to(root.resolve()).as_posix().encode() + b"=" + ver[d].encode() + b"\0")
        v = h.hexdigest()[:10]
        for f in comp:
            ver[f] = v
    return ver


def file_version(path: Path) -> str:
    return hashlib.sha256(clean(path)).hexdigest()[:10]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("frontend", nargs="?", default="frontend")
    a = ap.parse_args()

    root = Path(a.frontend).resolve()
    index = root / "index.html"
    if not index.is_file():
        sys.exit(f"{root} 里没有 index.html")
    overall = content_version(root)
    mods = module_versions(root)

    def version_of(target: Path) -> str:
        if target in mods:
            return mods[target]
        if target.is_file():
            return file_version(target)
        sys.exit(f"引用了不存在的文件：{target}")

    changed = 0
    for f in [index, *sorted((root / "js").rglob("*.js"))]:
        src = f.read_text(encoding="utf-8")
        pat = HTML_REF if f == index else JS_IMPORT

        def stamp(m: re.Match, f=f) -> str:
            head, path, _old, quote = m.groups()
            return f"{head}{path}?v={version_of(resolve(f, path, root))}{quote}"

        out = pat.sub(stamp, src)
        if f == index:
            out = META.sub("", out)
            out = out.replace("<head>\n", f'<head>\n  <meta name="ety-version" content="{overall}">\n', 1)
        if out != src:
            f.write_text(out, encoding="utf-8")
            changed += 1
    html = index.read_text(encoding="utf-8")
    if "/js/main.js?v=" not in html or f'content="{overall}"' not in html:
        sys.exit("index.html 里找不到 /js/main.js 或 <head>，没法打版本号")
    # 每个模块都得在 index.html 里 modulepreload：Service Worker 靠这份清单预取新版本、清理旧文件
    missing = [p.relative_to(root).as_posix() for p in mods if f"/{p.relative_to(root).as_posix()}?v=" not in html]
    if missing:
        sys.exit(f"这些模块没在 index.html 里 modulepreload：{', '.join(missing)}")
    print(overall)
    print(f"版本 {overall}：改写了 {changed} 个文件（按文件版本号）", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""把一本词源书的 epub 转成词条数据（docs/DATA_FORMAT.md 的格式，带 book 字段），写到 backend/data/<书>.json。

    python3 -I backend/scripts/import-book.py <epub 文件> <书的 id>

目前认得两本书的版式（书目见 backend/data/books.json）：
  laili  《这个词是怎么来的：英语单词起源趣谈》：h2 词头 + [音标]，下面分“释义 / 相关词组 / 起源 / 例句”几节
  lishi  《单词的历史：英语词源漫谈》：h3 “词头 + 中文释义”，正文是散文；引文、例句用楷体段落，译者按是脚注

正文、释义、例句照原书（只统一了中英文之间的空格、去掉了脚注编号，脚注接在所属词条正文末尾）。
书里没有的编辑字段由程序粗略生成，记在 auto 里，网页上会注明，后台可以照“补写原书词条”的流程改写：
  teaser 按释义套模板（不剧透来历）；themes / subtheme / langs 按正文关键词归类；era 取正文里最早的年代。

和 entries.json 一样放在 backend/data/、进仓库、随部署同步；书目（标题、作者、文件名）在 backend/data/books.json。
"""
import hashlib
import json
import os
import re
import sys
import unicodedata
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

CJK = "\u3400-\u9fff\uf900-\ufaff"
# 全角标点、中文双引号：和英文挨着时不加空格。‘’ 不算：英文里 ’ 是撇号（Davy Jones’ locker 的空格要留着）
FULLPUNCT = "\u3000-\u303f\uff00-\uffef“”—…·"


# ---------- epub → 一串段落块 ----------

class Blocks(HTMLParser):
    """把一个 html 文件拆成 [(标签, class, 文本, 脚注引用)]；<i>/<em> 变成 *斜体*，<sup> 里的 (n) 记成脚注引用"""

    BLOCK = {"p", "h1", "h2", "h3", "h4", "div", "li"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.cur = None
        self.in_sup = False
        self.skip = 0  # <head>、音标 span 之类单独处理的

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("head", "script", "style"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.cur = {"tag": tag, "cls": a.get("class", ""), "text": "", "ipa": "", "refs": [], "anchor": ""}
        elif self.cur is not None:
            if tag in ("i", "em"):
                self.cur["text"] += "*"
            elif tag == "sup":
                self.in_sup = True
            elif tag == "span" and "yinbiao" in a.get("class", ""):
                self.cur["in_ipa"] = True
            elif tag == "a" and a.get("id", "").startswith("jz_"):
                self.cur["anchor"] = a["id"]
            elif tag == "br":
                self.cur["text"] += "\n"
            elif tag == "img":
                # 行内小图：有的书用图片排特殊字母（如古英语的 ȳ），先留个记号，各书再换成字
                self.cur["text"] += "{img:" + os.path.basename(a.get("src", "")) + "}"

    def handle_endtag(self, tag):
        if tag in ("head", "script", "style"):
            self.skip -= 1
        elif tag in self.BLOCK and self.cur is not None:
            self.out.append(self.cur)
            self.cur = None
        elif self.cur is not None:
            if tag in ("i", "em"):
                self.cur["text"] += "*"
            elif tag == "sup":
                self.in_sup = False
            elif tag == "span":
                self.cur.pop("in_ipa", None)

    def handle_data(self, data):
        if self.skip or self.cur is None:
            return
        if self.in_sup:
            m = re.search(r"\d+", data)
            if m:
                self.cur["refs"].append(int(m.group()))
            return
        if self.cur.get("in_ipa"):
            self.cur["ipa"] += data
        else:
            self.cur["text"] += data


def read_epub(path):
    z = zipfile.ZipFile(path)
    container = ET.fromstring(z.read("META-INF/container.xml"))
    opf_path = container.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile").get("full-path")
    base = os.path.dirname(opf_path)
    opf = ET.fromstring(z.read(opf_path))
    ns = {"o": "http://www.idpf.org/2007/opf"}
    items = {i.get("id"): i.get("href") for i in opf.find("o:manifest", ns)}
    files = []
    for ref in opf.find("o:spine", ns):
        href = items[ref.get("idref")]
        p = Blocks()
        p.feed(z.read(os.path.join(base, href).replace("\\", "/")).decode("utf-8"))
        files.append((href, p.out))
    return files


# ---------- 文本整理 ----------

def tidy(s):
    """合并 epub 里的折行；中英文之间留一个空格（和 entries.json 的写法一致）；斜体记号贴紧单词"""
    s = s.replace("\u00a0", " ")
    s = re.sub(r"\{img:[^}]*\}\s*", "", s)  # 没换成字的图片（插图之类）不要
    s = re.sub(r"\s*\n\s*", " ", s)
    s = re.sub(r"\*\s*\*", "", s)  # 空的斜体
    s = re.sub(r"\*\s+([^*]*?)\s*\*", r"*\1*", s)
    s = re.sub(r"[ \t]+", " ", s).strip()
    # 全角标点、中文旁边不要空格，再在中文和英文 / 数字之间加回一个
    s = re.sub(rf"\s+(?=[{CJK}{FULLPUNCT}])", "", s)
    s = re.sub(rf"(?<=[{CJK}{FULLPUNCT}])\s+", "", s)
    s = re.sub(rf"([{CJK}])(\*?[A-Za-z0-9])", r"\1 \2", s)
    s = re.sub(rf"([A-Za-z0-9.%]\*?)([{CJK}])", r"\1 \2", s)
    # 斜体成对才留着，不成对就去掉（免得渲染出错）
    if s.count("*") % 2:
        s = s.replace("*", "")
    return s


def slug(head):
    s = unicodedata.normalize("NFKD", head).encode("ascii", "ignore").decode()  # grâce → grace
    s = s.lower().replace("’", "").replace("'", "").replace("*", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


# ---------- 程序归类：专题、子专题、语源、年代、钩子 ----------

THEME_KEYS = {
    "希腊罗马神话": r"希腊神话|罗马神话|神话|宙斯|朱庇特|维纳斯|阿波罗|女神|天神|奥林匹斯|特洛伊|荷马|赫拉克勒斯|普罗米修斯|缪斯|丘比特",
    "圣经与宗教": r"圣经|《创世记》|《出埃及记》|上帝|耶稣|基督|教会|教堂|宗教|修道|牧师|主教|天主教|新约|旧约|使徒|犹太教|伊斯兰|佛教|祈祷|圣徒|圣人",
    "文学与书刊": r"小说|莎士比亚|诗人|诗歌|戏剧|剧作|作家|童话|寓言|报纸|杂志|狄更斯|乔叟|弥尔顿|斯威夫特|作品",
    "历史事件": r"战争|战役|革命|王朝|国王|女王|皇帝|起义|十字军|拿破仑|世界大战|中世纪|殖民",
    "人名": r"以[^。，]{0,12}名字命名|以其名|名叫|人名|姓氏|的名字",
    "地名": r"地名|城市|小镇|村庄|岛|地区|以[^。，]{0,8}地名",
    "体育与娱乐": r"比赛|运动|球|赛马|拳击|板球|棒球|游戏|马戏|扑克|赌博|纸牌|剧院|演员|舞台",
    "动物与自然": r"动物|鸟|鱼|狗|猫|熊|狼|狐|蛇|昆虫|植物|花|树|天气|星星|月亮|太阳",
    "农牧与狩猎": r"农民|耕|牧|羊|猎|狩猎|鹰|猎犬|庄稼|农场|养殖",
    "航海与军事": r"船|航海|水手|海军|舰|军队|士兵|军官|战舰|港口|海员|水兵|作战|武器|枪|炮",
    "商业与经济": r"钱|货币|银行|商人|贸易|市场|价格|税|工资|买卖|商店|生意|债|金币|硬币",
    "政治与法律": r"法律|法庭|议会|政治|选举|政府|总统|法官|罪犯|审判|警察|监狱|投票|政党",
    "新词与构词": r"缩略|首字母|拼缀|组合而成|新造|造出|创造了这个词|合成词|缩写",
}
SUB_KEYS = {
    "饮食": r"吃|食物|酒|菜|面包|肉|茶|咖啡|饭|厨|烹|糖|水果",
    "衣饰容貌": r"衣|服装|帽|鞋|裙|头发|化妆|首饰|戴|穿",
    "居家器物": r"家具|房子|床|椅|桌|器具|工具|屋|房间|厨房",
    "出行交通": r"马车|车|道路|旅行|交通|骑|旅馆",
    "岁时节令": r"月份|节日|节|季节|日历|星期|圣诞|新年|复活节",
    "婚恋家庭": r"婚|恋|妻|丈夫|家庭|孩子|母亲|父亲|新娘|求爱",
    "身体情绪": r"身体|病|医|心情|情绪|害怕|疼|痛|笑|哭|愤怒",
    "交际礼俗": r"礼|问候|再见|谢谢|习俗|仪式|客人|宴",
    "消遣娱乐": r"娱乐|游戏|音乐|舞|歌|派对|玩",
    "花草风物": r"花|草|植物|风景|园",
    "众生百态": r"人们|傻|疯|骗子|乞丐|小偷|懒|笨",
}
LANG_KEYS = [
    ("希腊语", r"希腊语|希腊文"), ("拉丁语", r"拉丁语|拉丁文"), ("古法语", r"古法语"),
    ("法语", r"(?<!古)法语|(?<!古)法文"), ("阿拉伯语", r"阿拉伯语"), ("希伯来语", r"希伯来语|希伯来文"),
    ("日耳曼语", r"日耳曼语"), ("古英语", r"古英语"), ("意大利语", r"意大利语"), ("西班牙语", r"西班牙语"),
    ("荷兰语", r"荷兰语"), ("德语", r"德语"), ("美国英语", r"美国英语|美式英语|美语"),
    ("其他", r"日语|汉语|印第安|波斯语|梵语|土耳其语|葡萄牙语|俄语|斯拉夫语|凯尔特语|盖尔语|古诺尔斯语|斯堪的纳维亚|印地语|马来语|非洲|爱尔兰语|威尔士语|挪威语|瑞典语|丹麦语|冰岛语"),
]
CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def cn_int(s):
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if s.startswith("十"):
        return 10 + CN_NUM.get(s[1:], 0)
    if "十" in s:
        a, _, b = s.partition("十")
        return CN_NUM.get(a, 0) * 10 + (CN_NUM.get(b, 0) if b else 0)
    return CN_NUM.get(s, 0)


def guess_era(text):
    cents = []
    for m in re.finditer(r"(公元前|前)?\s?([0-9一二三四五六七八九十]{1,3})\s?世纪", text):
        n = cn_int(m.group(2))
        if 0 < n <= 21:
            cents.append(-n if m.group(1) else n)
    for m in re.finditer(r"(公元前|前)?\s?(\d{3,4})\s?年", text):
        y = int(m.group(2))
        if m.group(1):
            cents.append(-((y - 1) // 100 + 1))
        elif 100 <= y <= 2025:
            cents.append((y - 1) // 100 + 1)
    return min(cents) if cents else None


def best(keys, text, top=2, floor=1):
    scored = sorted(((len(re.findall(rx, text)), k) for k, rx in keys.items()), key=lambda x: -x[0])
    return [k for n, k in scored[:top] if n >= floor]


def classify(e):
    text = " ".join([e["meaning"], *e["etymology"]])
    themes = best(THEME_KEYS, text, top=2, floor=2) or best(THEME_KEYS, text, top=1, floor=1)
    # 人名、地名只是辅助标签，单独出现时再配一个
    if not themes or all(t in ("人名", "地名") for t in themes):
        themes = themes + ["风俗与生活"]
    out = {"themes": themes[:3]}
    if "风俗与生活" in themes:
        out["subtheme"] = (best(SUB_KEYS, text, top=1, floor=2) or ["世情俗语"])[0]
    langs = [name for name, rx in LANG_KEYS if re.search(rx, text)]
    if langs:
        out["langs"] = langs
    era = guess_era(text)
    if era:
        out["era"] = era
    return out


def gloss(meaning):
    g = re.split(r"[；;，,、]", re.sub(r"（[^）]*）|\([^)]*\)|“|”", "", meaning))[0].strip()
    return g[:14]


def teaser(head, meaning):
    """head 是要问的那个说法（习语条目用习语本身），meaning 可能为空"""
    g = gloss(meaning)
    h = head.replace("*", "")
    n = int(hashlib.sha1(h.encode()).hexdigest()[:4], 16)
    if not g:
        return f"{h} 这个说法，是怎么来的？"
    if " " in h:
        t = [f"“{g}”为什么说成 {h}？", f"说“{g}”，英语里为什么是 {h}？", f"{h}，字面上和“{g}”有什么关系？"]
    else:
        t = [f"英语里的“{g}”，为什么叫 {h}？", f"{h} 怎么就成了“{g}”？", f"“{g}”叫 {h}，背后有什么来历？"]
    out = t[n % len(t)]
    return out if len(out) <= 40 else f"{h}，是怎么来的？"


# ---------- 两本书各自的版式 ----------

POS_TAG = r"(?:n|v|vt|vi|adj|adv|prep|conj|int|interj|pron|num|abbr|art|aux)"
# 词性标记，连写的“vt.& vi.”算一组；前面可能是空格、分号、括号或中文逗号
POS_RE = re.compile(rf"(?:(?<=^)|(?<=[\s　；;）)，,！!。]))({POS_TAG}\.(?:\s*&\s*{POS_TAG}\.)*)\s*")
NOTE_RE = re.compile(r"^(同义词|反义词|名词|动词|形容词|副词|复数|过去式|派生词)")


def parse_laili(files):
    entries, cur, sec = [], None, None
    for href, blocks in files:
        for b in blocks:
            t, cls = b["text"], b["cls"]
            if b["tag"] == "h2" and "title2" in cls:
                # 书里的 æ 有一部分是西里尔字母 ӕ（长得一样），统一换回来
                cur = {"headword": tidy(t), "ipa": tidy(b["ipa"]).strip("[]/ ").replace("ӕ", "æ"), "pos": "", "meaning": "",
                       "etymology": [], "examples": [], "phrases": [], "notes": [], "section": href}
                entries.append(cur)
                sec = None
                continue
            if b["tag"] == "h1" or cur is None:
                if b["tag"] == "h1":
                    cur = None
                continue
            text = tidy(t)
            if not text:
                continue
            if cls == "subtitle":
                sec = re.sub(r"\s", "", text)
                continue
            if sec == "释义":
                if NOTE_RE.match(text) or cur["meaning"]:
                    cur["notes"].append(text)
                else:
                    parts = POS_RE.split(text)
                    if len(parts) > 1:
                        pos = [p for i in range(1, len(parts), 2) for p in re.findall(r"[a-z]+", parts[i])]
                        means = [parts[i].strip(" 　；;，,") for i in range(2, len(parts), 2)]
                        cur["pos"] = " & ".join(dict.fromkeys(pos))
                        cur["meaning"] = "；".join(m for m in means if m)
                    else:
                        cur["meaning"] = text
            elif sec == "相关词组":
                cur["phrases"].append(re.sub(r"^\d+[.．、]\s*", "", text))
            elif sec == "起源":
                cur["etymology"].append(text)
            elif sec == "例句":
                m = re.match(r"^\d+[.．、]\s*(.*)$", text)
                if m and re.search(r"[A-Za-z]", m.group(1)) and not re.search(f"[{CJK}]", m.group(1)):
                    cur["examples"].append({"en": m.group(1), "zh": ""})
                elif cur["examples"] and not cur["examples"][-1]["zh"]:
                    cur["examples"][-1]["zh"] = text
    for e in entries:
        e["examples"] = [x for x in e["examples"] if x["en"] and x["zh"]]
    return entries


HEAD_RE = re.compile(r"^(?P<en>[^" + CJK + r"（“〔]+?)\s*(?P<zh>[（“〔" + CJK + r"].*)?$")


def split_head(raw):
    """“aback (*be taken aback*)吃惊” → 词头 aback、习语 [be taken aback]、释义“吃惊”"""
    raw = tidy(raw)
    phrases = []
    m = re.match(r"^(.*?)\s*\(\s*\*([^*]+)\*\s*\)\s*(.*)$", raw)
    if m:
        phrases = [p.strip() for p in m.group(2).split(";") if p.strip()]
        raw = (m.group(1) + " " + m.group(3)).strip()
    m = HEAD_RE.match(raw)
    en, zh = (m.group("en").strip(), (m.group("zh") or "").strip()) if m else (raw, "")
    en = en.replace("*", "").strip().rstrip("…").strip()
    heads = [h.strip() for h in en.split(";") if h.strip()]
    return heads[0], heads[1:], phrases, zh


# 《单词的历史》正文里用图片排的字（class="pic-s"）
LISHI_GLYPHS = {"Image00004.gif": "ȳ", "Image00005.gif": "ȳ", "Image00014.gif": "ȳ", "Image00012.gif": "℞"}


def glyphs(text, table):
    """把行内图片记号换成字；不认识的图片直接去掉。图片后面 epub 带的折行不算空格"""
    return re.sub(r"\{img:([^}]*)\}\s*", lambda m: table.get(m.group(1), ""), text)


def parse_lishi(files):
    entries, cur = [], None
    for href, blocks in files:
        notes = {}  # 这个文件里的脚注：编号 → 正文
        owner = {}  # 脚注编号 → 引用它的词条
        for b in blocks:
            cls = b["cls"]
            if cls == "fnContent-1":
                m = re.match(r"\s*\((\d+)\)\s*(.*)$", b["text"], re.S)
                if m:
                    notes[int(m.group(1))] = tidy(m.group(2))
                continue
            if b["tag"] == "h1":
                cur = None
                if "backtitle" in cls:
                    break  # 书末索引
                continue
            if b["tag"] == "h3":
                if cls != "txtheading-1":
                    continue
                head, variants, phrases, zh = split_head(b["text"])
                cur = {"headword": head, "variants": variants, "phrases": phrases, "ipa": "", "pos": "", "meaning": zh,
                       "etymology": [], "examples": [], "notes": [], "section": href}
                entries.append(cur)
                continue
            if cur is None or b["tag"] != "p" or "bodyContent" not in cls and "quoteContent" not in cls:
                continue
            text = tidy(glyphs(re.sub(r"\(\d+\)", "", b["text"]), LISHI_GLYPHS))
            for r in b["refs"]:
                owner[r] = cur
            if not text:
                continue
            if "kaiti" in cls or "quoteContent" in cls:
                cur["etymology"].append("> " + text)  # 引文、例句：网页上排成缩进的引文
            else:
                cur["etymology"].append(text)
        for n, e in owner.items():
            if n in notes:
                e["etymology"].append("〔注〕" + re.sub(r"^\[译者按\]\s*", "译者按：", notes[n]))
    for e in entries:
        # 音标：正文开头写成“banal /bəˈnɑːl/形容……”的
        m = re.search(r"/([^/\s][^/]{0,40})/", e["etymology"][0] if e["etymology"] else "")
        if m and re.search(r"[ˈˌəɪʊʌæɑɒɔː]", m.group(1)):
            e["ipa"] = m.group(1)
    return entries


PARSERS = {"laili": parse_laili, "lishi": parse_lishi}


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in PARSERS:
        sys.exit(__doc__)
    epub, book = sys.argv[1], sys.argv[2]
    raw = PARSERS[book](read_epub(epub))
    out, seen = [], {}
    for e in raw:
        if not e["etymology"]:
            print(f"跳过（没有正文）：{e['headword']}", file=sys.stderr)
            continue
        base = slug(e["headword"])
        n = seen[base] = seen.get(base, 0) + 1
        entry = {
            "id": f"{base}{'' if n == 1 else f'-{n}'}--{book}",
            "book": book,
            "headword": e["headword"],
        }
        if e.get("variants"):
            entry["variants"] = e["variants"]
        entry["ipa"] = e["ipa"]
        if e["pos"]:
            entry["pos"] = e["pos"]
        entry["meaning"] = e["meaning"]
        if e.get("phrases"):
            entry["phrases"] = e["phrases"]
        if e.get("notes"):
            entry["wordNotes"] = e["notes"]
        entry["teaser"] = teaser((e.get("phrases") or [e["headword"]])[0] if e.get("variants") is not None else e["headword"], e["meaning"])
        entry["etymology"] = e["etymology"]
        entry["examples"] = e["examples"]
        auto = classify(entry)
        entry.update(auto)
        entry["auto"] = ["teaser", *auto.keys()]
        out.append(entry)

    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, f"{book}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{book}: {len(out)} 条 → {path}")


if __name__ == "__main__":
    main()

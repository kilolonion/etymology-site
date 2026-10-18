// 发音与查词。
// 发音按质量依次尝试：真人录音（Wiktionary / Wikimedia Commons）→ 有道词典发音（单词、短语）→ Google 朗读（整句）。
// 取到的音频存到磁盘，同一段话第二次就不用再联网；都取不到时返回 null，页面退回浏览器自带的朗读。
// 查词（不在书里的词）用有道的简明释义，存在内存里。

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Accent = "uk" | "us";

let dir = "";
export function initSpeech(cacheDir: string): void {
  dir = cacheDir;
  mkdirSync(dir, { recursive: true });
}

/** 整理要读的文字：去掉 Markdown 斜体记号、多余空白；太长的不读（Google 朗读一次最多 200 字） */
export function cleanSpeech(text: string): string {
  const s = text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  return s.length <= 200 ? s : "";
}

/** 像一个词或短语（最多四个词），才有可能查到录音、走词典发音 */
const isWordish = (s: string) => /^[a-z][a-z'’.-]*( [a-z][a-z'’.-]*){0,3}$/i.test(s);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
// Wikimedia 要求写明是谁在请求，不然容易被限流
const WIKI_UA = "etymology-site/1.0 (https://github.com/kilolonion/etymology-site; pronunciation cache)";

async function get(url: string, ms = 6000): Promise<Response | undefined> {
  try {
    const ua = /wiki(media|pedia|tionary)\.org/.test(url) ? WIKI_UA : UA;
    const res = await fetch(url, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(ms) });
    return res.ok ? res : undefined;
  } catch {
    return undefined;
  }
}

async function getAudio(url: string): Promise<Buffer | undefined> {
  const res = await get(url);
  if (!res || !/audio|mpeg|octet-stream/.test(res.headers.get("content-type") ?? "")) return undefined;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 800 ? buf : undefined; // 太小的多半是错误页
}

/**
 * Wiktionary 的真人录音：查词条页面用到的音频文件（En-uk-water.ogg 这种，文件名里写着口音），
 * 再从 Wikimedia Commons 取它转好的 mp3。口音对不上就不用，宁可用口音对的词典发音。
 */
async function recording(word: string, accent: Accent): Promise<Buffer | undefined> {
  const tag = accent === "uk" ? /^File:En-(uk|gb|rp)-.+\.(ogg|oga|wav|flac|mp3)$/i : /^File:En-us-.+\.(ogg|oga|wav|flac|mp3)$/i;
  // 页面标题区分大小写：先按原样查（Wednesday），再试小写
  for (const title of [...new Set([word, word.toLowerCase()])]) {
    const res = await get(
      `https://en.wiktionary.org/w/api.php?action=query&prop=images&imlimit=100&format=json&formatversion=2&titles=${encodeURIComponent(title)}`,
      5000,
    );
    if (!res) return undefined;
    const data = (await res.json().catch(() => ({}))) as { query?: { pages?: { images?: { title: string }[] }[] } };
    const file = data.query?.pages?.[0]?.images?.map((i) => i.title).find((t) => tag.test(t));
    if (!file) continue;
    // Commons 的文件名首字母总是大写（页面上可能写成小写的 en-uk-…）
    const raw = file.slice(5).replace(/ /g, "_");
    const name = raw[0]!.toUpperCase() + raw.slice(1);
    const h = createHash("md5").update(name).digest("hex");
    const enc = encodeURIComponent(name);
    return getAudio(`https://upload.wikimedia.org/wikipedia/commons/transcoded/${h[0]}/${h.slice(0, 2)}/${enc}/${enc}.mp3`);
  }
  return undefined;
}

const youdao = (text: string, accent: Accent) =>
  getAudio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${accent === "uk" ? 1 : 2}`);

const google = (text: string, accent: Accent) =>
  getAudio(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${accent === "uk" ? "en-GB" : "en-US"}&q=${encodeURIComponent(text)}`);

export type Clip = { audio: Buffer; source: string };

const inflight = new Map<string, Promise<Clip | null>>();

/** 取一段发音：先看磁盘，再按质量依次去取 */
export function speech(text: string, accent: Accent): Promise<Clip | null> {
  const key = createHash("sha1").update(`${accent}|${text.toLowerCase()}`).digest("hex");
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = (async () => {
    const file = join(dir, `${key}.mp3`);
    const hit = await readFile(file).catch(() => undefined);
    if (hit) return { audio: hit, source: "cache" };
    const tries: [string, () => Promise<Buffer | undefined>][] = isWordish(text)
      ? [["wiktionary", () => recording(text, accent)], ["youdao", () => youdao(text, accent)], ["google", () => google(text, accent)]]
      : [["google", () => google(text, accent)]];
    for (const [source, fn] of tries) {
      const audio = await fn();
      if (!audio) continue;
      // 先写临时文件再改名，并发时不会读到写了一半的文件
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, audio).then(() => rename(tmp, file)).catch(() => {});
      return { audio, source };
    }
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- 查词：书里没有的词，给个简明中文释义 ----------

const glossCache = new Map<string, string>();
const GLOSS_MAX = 3000;

export async function gloss(word: string): Promise<string> {
  const w = word.toLowerCase();
  if (glossCache.has(w)) return glossCache.get(w)!;
  const res = await get(`https://dict.youdao.com/suggest?q=${encodeURIComponent(w)}&num=1&doctype=json&le=en`, 5000);
  const data = res ? ((await res.json().catch(() => ({}))) as { data?: { entries?: { entry?: string; explain?: string }[] } }) : {};
  const hit = data.data?.entries?.find((x) => x.entry?.toLowerCase() === w);
  const text = hit?.explain ?? "";
  if (res) {
    // 没查到也记下，免得反复去问；只有请求失败时不记
    glossCache.set(w, text);
    if (glossCache.size > GLOSS_MAX) glossCache.delete(glossCache.keys().next().value!);
  }
  return text;
}

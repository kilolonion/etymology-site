// 词条数据结构，与 docs/DATA_FORMAT.md 保持一致。

export const THEMES = [
  "希腊罗马神话", "圣经与宗教", "文学与书刊", "历史事件", "人名", "地名",
  "体育与娱乐", "风俗与生活", "动物与自然", "农牧与狩猎", "航海与军事",
  "商业与经济", "政治与法律", "新词与构词",
] as const;

/** 词条太多的专题再细分一层；每个词条在该专题下只归一个子专题 */
export const SUBTHEMES: Partial<Record<(typeof THEMES)[number], readonly string[]>> = {
  风俗与生活: [
    "饮食", "衣饰容貌", "居家器物", "出行交通", "岁时节令", "婚恋家庭",
    "身体情绪", "众生百态", "交际礼俗", "消遣娱乐", "花草风物", "世情俗语",
  ],
};

export const LANGS = [
  "希腊语", "拉丁语", "法语", "古法语", "阿拉伯语", "希伯来语", "日耳曼语",
  "古英语", "意大利语", "西班牙语", "荷兰语", "德语", "美国英语", "其他",
] as const;

export type Example = { en: string; zh: string };

/** 词书（data/books.json）。entries.json 是第一本（BASE_BOOK），其余每本一个文件，词条带 book 字段、id 带 --书名 后缀 */
export const BASE_BOOK = "cidian";
export type Book = {
  id: string;
  title: string;
  /** 页面上的简称 */
  short: string;
  /** 一个字的书签（列表里区分同一个词的不同版本） */
  seal: string;
  author: string;
  publisher?: string;
  year?: number;
  /** 相对 data/ 的文件名 */
  file: string;
  /** 词条有页码（epub 导入的没有） */
  pages?: boolean;
  /** 选书页上的一句介绍 */
  intro?: string;
  /** 出处卡上的说明：哪些照原书 */
  note: string;
};
/** 程序生成（不是书里的、也不是编辑写的）的字段，导入时记在 auto 里，网页上注明 */
/** 别的书导入时程序生成的字段：前五个按正文关键词归类，keyline、links 由 AI 依据正文补写（见 scripts/import-book.py 和 docs/DATA_FORMAT.md） */
export const AUTO_FIELDS = ["teaser", "themes", "subtheme", "langs", "era", "keyline", "links"] as const;

/** 词条之间的关系（书里的“参见”之外另行整理的）：同根、同典故、一个由另一个衍生 */
export const LINK_TYPES = ["同根", "同典故", "衍生"] as const;
export type LinkType = (typeof LINK_TYPES)[number];
/** 一对关系只记在其中一个词条上，加载时自动补成双向 */
export type Link = { id: string; type: LinkType; why: string };

export type FullEntry = {
  id: string;
  /** 出自哪本书；没有就是第一本（entries.json），后台新增的词加载后也没有 */
  book?: string;
  headword: string;
  variants?: string[];
  ipa: string;
  pos: string;
  meaning: string;
  /** 书里列出的相关词组 / 这一条讲的习语 */
  phrases?: string[];
  /** 释义下面的同义词、反义词、派生词等小字 */
  wordNotes?: string[];
  teaser: string;
  /** 读完后“记住这一句”：一句话概括来历 */
  keyline?: string;
  /** 词义演变，2–4 步，从最早的来源到今义 */
  evolution?: string[];
  etymology: string[];
  examples: Example[];
  seeAlso?: string[];
  /** 书外整理的关系，见 Link */
  links?: Link[];
  themes: string[];
  langs?: string[];
  /** 所属专题下的子专题（见 SUBTHEMES） */
  subtheme?: string;
  /** 故事起点所在的世纪：正文提到的最早年代，16 即 16 世纪，公元前为负数 */
  era?: number;
  /** 书中页码；不在书里的词（后台新增的）没有 */
  page?: number;
  /** 不在书里的词才有：谁写的、参考了什么、哪里拿不准、有没有人核对过 */
  origin?: Origin;
  /** 导入时程序生成的字段（见 AUTO_FIELDS）；后台补写过的字段会从这里去掉 */
  auto?: string[];
  /** 原书词条被后台补过编辑字段时才有：补了哪些字段、来源 */
  patched?: { fields: string[]; origin: Origin };
};

/** 后台新增 / 补写内容的来源 */
export const ORIGIN_KINDS = ["ai", "manual"] as const;
export type Source = { title: string; url?: string };
export type Origin = {
  /** ai：AI 生成；manual：管理员自己写的 */
  kind: (typeof ORIGIN_KINDS)[number];
  /** 生成它的模型，人写的不填 */
  model?: string;
  /** 怎么进来的：后台粘贴导入、MCP 提交、后台手写 */
  via?: "import" | "mcp" | "manual";
  /** 参考来源，AI 生成的至少一条 */
  sources: Source[];
  /** AI 自己拿不准的地方，原样给读者看 */
  doubts: string[];
  /** 管理员核对过才有；内容一改就清掉 */
  checked?: { by: string; at: string } | null;
};

/** 原书词条可以补写的字段（正文、释义、例句这些照原书，不许改） */
export const PATCH_FIELDS = ["teaser", "keyline", "evolution", "links", "era", "subtheme", "langs"] as const;

export type RedirectEntry = {
  id: string;
  book?: string;
  headword: string;
  ipa: string;
  redirect: string;
  page: number;
};

export type RawEntry = FullEntry | RedirectEntry;

export function isRedirect(e: RawEntry): e is RedirectEntry {
  return "redirect" in e;
}

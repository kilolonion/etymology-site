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

export type FullEntry = {
  id: string;
  headword: string;
  variants?: string[];
  ipa: string;
  pos: string;
  meaning: string;
  teaser: string;
  /** 读完后“记住这一句”：一句话概括来历 */
  keyline?: string;
  /** 词义演变，2–4 步，从最早的来源到今义 */
  evolution?: string[];
  etymology: string[];
  examples: Example[];
  seeAlso?: string[];
  themes: string[];
  langs?: string[];
  /** 所属专题下的子专题（见 SUBTHEMES） */
  subtheme?: string;
  /** 故事起点所在的世纪：正文提到的最早年代，16 即 16 世纪，公元前为负数 */
  era?: number;
  page: number;
};

export type RedirectEntry = {
  id: string;
  headword: string;
  ipa: string;
  redirect: string;
  page: number;
};

export type RawEntry = FullEntry | RedirectEntry;

export function isRedirect(e: RawEntry): e is RedirectEntry {
  return "redirect" in e;
}

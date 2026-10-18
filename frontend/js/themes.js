// 专题的配色、英文名、一句导语和线描纹章。每个词条用它的“主专题”着色。

export const THEMES = {
  "希腊罗马神话": { desc: "众神、英雄与史诗，留在英语里的名字。", color: "#3d5a80", en: "Mythology", emblem: '<path d="M3.5 4h17M5 6.5h14M7 6.5v11M10.3 6.5v11M13.7 6.5v11M17 6.5v11M5 17.5h14M3.5 20h17"/>' },
  "圣经与宗教": { desc: "从伊甸园到福音书，信仰里长出来的词。", color: "#8a6a2f", en: "Scripture", emblem: '<path d="M12 7.5c-2.2-2-6.3-1.4-6.8 3-.5 4.3 2.6 9.5 4.7 9.5 1 0 1.3-.6 2.1-.6s1.1.6 2.1.6c2.1 0 5.2-5.2 4.7-9.5-.5-4.4-4.6-5-6.8-3z"/><path d="M12 7.5c0-2.2 1-3.8 3.2-4.5M12 7.5c-.6-1.6-2-2.4-3.6-2.3"/>' },
  "文学与书刊": { desc: "小说人物、报刊栏目，从书页里走出来的词。", color: "#6b4f7a", en: "Letters", emblem: '<path d="M2.5 5.5c3.2-1.2 6.4-1 9.5 1.2v13c-3.1-2.2-6.3-2.4-9.5-1.2zM21.5 5.5c-3.2-1.2-6.4-1-9.5 1.2v13c3.1-2.2 6.3-2.4 9.5-1.2z"/>' },
  "历史事件": { desc: "战役、变革与名人轶事，一个词记住一段往事。", color: "#8a3b2c", en: "History", emblem: '<path d="M6 3h12M6 21h12M7.5 3v2.5c0 3 4.5 4.5 4.5 6.5s-4.5 3.5-4.5 6.5V21M16.5 3v2.5c0 3-4.5 4.5-4.5 6.5s4.5 3.5 4.5 6.5V21"/><path d="M10 18.5h4"/>' },
  "人名": { desc: "真实或虚构的人，名字后来成了普通的词。", color: "#56664a", en: "Names", emblem: '<ellipse cx="12" cy="12" rx="8" ry="9.5"/><path d="M8.5 18.5c.6-2.8 1.9-4.2 3.5-4.2s2.9 1.4 3.5 4.2"/><circle cx="12" cy="10" r="2.6"/>' },
  "地名": { desc: "城市、河流与远方，地名怎样变成日常用语。", color: "#2f6f6a", en: "Places", emblem: '<circle cx="12" cy="12" r="9"/><path d="m12 4.5 2.2 7.5-2.2 7.5-2.2-7.5z"/><path d="M4.5 12h3M16.5 12h3"/>' },
  "体育与娱乐": { desc: "赛场、牌桌与游戏，玩着玩着就进了词典。", color: "#b0573a", en: "Sport & Play", emblem: '<path d="M8 3.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 5H5.2a3 3 0 0 0 3 4.2M16 5h2.8a3 3 0 0 1-3 4.2M12 12.5v3.5M9 20.5h6M10 16h4v4.5h-4z"/>' },
  "风俗与生活": { desc: "衣食住行里的老习惯，悄悄改变了词义。", color: "#9a4f68", en: "Customs", emblem: '<path d="M4.5 10h11v3.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M15.5 11h1.6a2.4 2.4 0 0 1 0 4.8h-1.9M3.5 21h14M8 3.5c-.8 1 .8 2 0 3.2M11.5 3.5c-.8 1 .8 2 0 3.2"/>' },
  "动物与自然": { desc: "鸟兽草木，被人借来说人的事。", color: "#4a7346", en: "Nature", emblem: '<path d="M4.5 19.5C4.5 10.5 10 4.8 20 4c-.8 10-6.5 15.5-15.5 15.5z"/><path d="m4.5 19.5 8.5-8.5M9 15h4M12 12v-3"/>' },
  "农牧与狩猎": { desc: "田野、牧场和猎场上的说法。", color: "#85702f", en: "Field & Hunt", emblem: '<path d="M20 3.5C11.5 3.5 5.5 10 5.5 18.5L3.5 20.5"/><path d="M20 3.5c0 8.5-6 14.5-14.5 15M9.5 14.5h5.5M12.5 10.5h5"/>' },
  "航海与军事": { desc: "水手和士兵的行话，后来人人都在用。", color: "#2b4766", en: "Sea & Arms", emblem: '<circle cx="12" cy="4.8" r="2"/><path d="M12 6.8v14M8 10h8M3.5 13c0 4.5 3.8 8 8.5 8s8.5-3.5 8.5-8M3.5 13 2 14.5M20.5 13l1.5 1.5"/>' },
  "商业与经济": { desc: "集市、账房与交易所里的词。", color: "#9c7424", en: "Commerce", emblem: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 10v4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-4M4.5 14v4c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-4"/>' },
  "政治与法律": { desc: "议会、法庭与选举，权力留下的词。", color: "#4b4f70", en: "Law & Order", emblem: '<path d="M12 3v17.5M7.5 20.5h9M4.5 7h15M4.5 7 2 13.5a2.5 2.5 0 0 0 5 0zM19.5 7 17 13.5a2.5 2.5 0 0 0 5 0z"/><circle cx="12" cy="3.5" r=".5"/>' },
  "新词与构词": { desc: "新近造出来的词，看看它们是怎么拼起来的。", color: "#3b6e8c", en: "New Words", emblem: '<path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><path d="m6.5 6.5 2.2 2.2M15.3 15.3l2.2 2.2M6.5 17.5l2.2-2.2M15.3 8.7l2.2-2.2"/><circle cx="12" cy="12" r="2"/>' },
};

const FALLBACK = { desc: "", color: "#7a5a3a", en: "Words", emblem: THEMES["文学与书刊"].emblem };
const VAGUE = new Set(["人名", "地名"]);

export const themeOf = (name) => THEMES[name] ?? FALLBACK;

/** 词条的主专题：优先第一个不笼统的专题 */
export const primaryTheme = (e) => (e.themes ?? []).find((t) => !VAGUE.has(t)) ?? e.themes?.[0] ?? "";

/** 行内样式：把专题色交给 CSS 变量 --t */
export const tint = (e) => `--t:${themeOf(primaryTheme(e)).color}`;

export const emblem = (name, cls = "emblem") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${themeOf(name).emblem}</svg>`;

/** “纹章 + 中文名 · 英文名”的专题标签 */
export const themeTag = (name) =>
  `<span class="theme-tag">${emblem(name, "emblem-s")}<span>${name}</span><span class="en">${themeOf(name).en}</span></span>`;

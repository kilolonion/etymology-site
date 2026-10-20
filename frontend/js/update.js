// “要不要提示刷新”的判断，单独放一个文件：只有纯函数、不碰 DOM，方便在 node 里直接测。

/** 从首页 HTML 里取出前端整体版本号（<meta name="ety-version">；老版本页面没有，退回 main.js?v=xxxx） */
export const versionOfHtml = (html = "") =>
  html.match(/<meta name="ety-version" content="([\w.-]+)"/)?.[1] ?? html.match(/\/js\/main\.js\?v=([\w.-]+)/)?.[1] ?? "";

/** 当前页面自己的整体版本号 */
export const pageVersionOf = (doc = document) =>
  doc.querySelector('meta[name="ety-version"]')?.content ?? versionOfHtml(doc.documentElement?.outerHTML ?? "");

/** 线上最新版本和页面自己正在跑的版本不一样，才算“有新版本”；任何一边拿不到就不提示 */
export const isStale = (pageVersion, latest) => !!pageVersion && !!latest && pageVersion !== latest;

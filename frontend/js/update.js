// “要不要提示刷新”的判断，单独放一个文件：只有纯函数、不碰 DOM，方便在 node 里直接测。

/** 从首页 HTML 里取出前端版本号（index.html 里 main.js?v=xxxx） */
export const versionOfHtml = (html = "") => html.match(/\/js\/main\.js\?v=([\w.-]+)/)?.[1] ?? "";

/** 线上最新版本和页面自己正在跑的版本不一样，才算“有新版本”；任何一边拿不到就不提示 */
export const isStale = (pageVersion, latest) => !!pageVersion && !!latest && pageVersion !== latest;

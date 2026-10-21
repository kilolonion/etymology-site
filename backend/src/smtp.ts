// 发信层：一个够用的 SMTP 客户端（node:net / node:tls，不引依赖）。
// 支持 465 端口的直连 TLS 和 587 / 25 的 STARTTLS，AUTH PLAIN / LOGIN；一封信一个连接，发完就断。
// 配置全走环境变量（见 .env.example）；没配 SMTP_HOST 和 MAIL_FROM 时 mailConfigured() 为 false，调用方不发。

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import net from "node:net";
import tls from "node:tls";

type Security = "ssl" | "starttls" | "off";

export type SmtpConfig = {
  host: string;
  port: number;
  security: Security;
  user: string;
  pass: string;
  from: string;
  replyTo: string;
};

function readConfig(): SmtpConfig {
  const port = Number(process.env.SMTP_PORT ?? 0) || (process.env.SMTP_SECURE === "ssl" ? 465 : 587);
  const sec = process.env.SMTP_SECURE;
  return {
    host: process.env.SMTP_HOST ?? "",
    port,
    security: sec === "ssl" || sec === "starttls" || sec === "off" ? sec : port === 465 ? "ssl" : "starttls",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.MAIL_FROM ?? "",
    replyTo: process.env.MAIL_REPLY_TO ?? "",
  };
}

const config = readConfig();

export const mailConfigured = () => !!config.host && !!addrOf(config.from);

/** 后台显示用：不含密码 */
export const mailConfigInfo = () => ({
  host: config.host, port: config.port, security: config.security, user: config.user, from: config.from,
});

/** "词源一日 <daily@x.com>" → daily@x.com */
export function addrOf(s: string): string {
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1]! : s.trim()).replace(/[\r\n]/g, "");
}

/** 收件人地址是否像样：一个 @、没有空白和尖括号之类会破坏信头的字符 */
export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/.test(s);
}

// ---------- 信件 ----------

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** 额外的信头，比如 List-Unsubscribe */
  headers?: Record<string, string>;
};

/** 信头里的非 ASCII 文字：按 RFC 2047 编成若干段 =?UTF-8?B?…?=，每段不超过 75 个字符，不切断一个字 */
export function encodeWord(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const parts: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => `=?UTF-8?B?${Buffer.from(p).toString("base64")}?=`).join("\r\n ");
}

/** "名字 <addr>" 里的名字要编码，地址原样 */
function encodeAddress(s: string): string {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/);
  if (!m) return addrOf(s);
  return m[1] ? `${encodeWord(m[1])} <${m[2]}>` : `<${m[2]}>`;
}

const b64lines = (s: string) => Buffer.from(s).toString("base64").replace(/.{76}/g, "$&\r\n");

export function buildMessage(mail: Mail, from = config.from, replyTo = config.replyTo): string {
  const boundary = `=_ety_${randomBytes(12).toString("hex")}`;
  const domain = addrOf(from).split("@")[1] ?? "localhost";
  const headers: [string, string][] = [
    ["From", encodeAddress(from)],
    ["To", addrOf(mail.to)],
    ...(replyTo ? [["Reply-To", encodeAddress(replyTo)] as [string, string]] : []),
    ["Subject", encodeWord(mail.subject)],
    ["Date", new Date().toUTCString().replace("GMT", "+0000")],
    ["Message-ID", `<${Date.now().toString(36)}.${randomBytes(8).toString("hex")}@${domain}>`],
    ["MIME-Version", "1.0"],
    ...Object.entries(mail.headers ?? {}).map(([k, v]) => [k, v.replace(/[\r\n]/g, "")] as [string, string]),
    ["Content-Type", `multipart/alternative; boundary="${boundary}"`],
  ];
  return [
    ...headers.map(([k, v]) => `${k}: ${v}`),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(mail.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// ---------- SMTP 会话 ----------

const TIMEOUT = 20_000;

class SmtpError extends Error {
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.code = code;
  }
}

/** 一条连接：按行读回复（多行回复以 "250-" 续行，"250 " 结束），一问一答 */
class Session {
  private buf = "";
  private waiting: ((r: { code: number; lines: string[] }) => void) | null = null;
  private failed: ((e: Error) => void) | null = null;
  private lines: string[] = [];
  private error: Error | null = null;
  private socket!: net.Socket;

  constructor(socket: net.Socket) {
    this.attach(socket);
  }

  private attach(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setTimeout(TIMEOUT, () => this.fail(new SmtpError("SMTP 服务器没有响应（超时）")));
    socket.on("data", (d: string) => this.onData(d));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new SmtpError("SMTP 连接被断开")));
  }

  private fail(e: Error) {
    if (this.error) return;
    this.error = e;
    this.failed?.(e);
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const done = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        const w = this.waiting;
        this.waiting = null;
        this.failed = null;
        w?.(done);
      }
    }
  }

  read(): Promise<{ code: number; lines: string[] }> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failed = reject;
    });
  }

  /** 发一行命令，等回复；回复码不在 expect 里就抛错（错误里不带密码） */
  async cmd(line: string, expect: number[], shown = line): Promise<string[]> {
    const p = this.read();
    this.socket.write(line + "\r\n");
    const r = await p;
    if (!expect.includes(r.code)) throw new SmtpError(`${shown.split(" ")[0]} 被拒绝：${r.code} ${r.lines.join(" ").slice(0, 200)}`, r.code);
    return r.lines;
  }

  /** STARTTLS：在原连接上升级成 TLS */
  async upgrade(host: string): Promise<void> {
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    raw.setTimeout(0);
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: raw, servername: host }, () => resolve(s));
      s.once("error", reject);
    });
    this.attach(secure);
  }

  write(data: string) {
    this.socket.write(data);
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

function connect(c: SmtpConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = c.security === "ssl"
      ? tls.connect({ host: c.host, port: c.port, servername: c.host }, () => resolve(s))
      : net.connect({ host: c.host, port: c.port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(TIMEOUT, () => {
      s.destroy();
      reject(new SmtpError(`连不上 ${c.host}:${c.port}（超时）`));
    });
  });
}

/** 发一封信。成功返回服务器给的回执（多半含队列号），失败抛错 */
export async function sendMail(mail: Mail, c: SmtpConfig = config): Promise<string> {
  if (!c.host || !addrOf(c.from)) throw new SmtpError("还没有配置 SMTP（SMTP_HOST、MAIL_FROM）");
  const to = addrOf(mail.to);
  if (!isEmail(to)) throw new SmtpError("收件地址不对");
  const s = new Session(await connect(c));
  try {
    const greet = await s.read();
    if (greet.code !== 220) throw new SmtpError(`SMTP 服务器拒绝连接：${greet.code} ${greet.lines.join(" ")}`);
    const me = hostname() || "localhost";
    let caps = await s.cmd(`EHLO ${me}`, [250]);
    if (c.security === "starttls") {
      if (!caps.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError("服务器不支持 STARTTLS（可设 SMTP_SECURE=ssl 改用 465 端口）");
      await s.cmd("STARTTLS", [220]);
      await s.upgrade(c.host);
      caps = await s.cmd(`EHLO ${me}`, [250]);
    }
    if (c.user) {
      const auth = caps.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
      if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
        await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass}`).toString("base64")}`, [235], "AUTH");
      } else {
        await s.cmd("AUTH LOGIN", [334]);
        await s.cmd(Buffer.from(c.user).toString("base64"), [334], "AUTH");
        await s.cmd(Buffer.from(c.pass).toString("base64"), [235], "AUTH");
      }
    }
    await s.cmd(`MAIL FROM:<${addrOf(c.from)}>`, [250]);
    await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await s.cmd("DATA", [354]);
    // 行首的点要双写（base64 正文不会出现，但信头可能）
    const body = buildMessage(mail, c.from, c.replyTo).replace(/^\./gm, "..");
    const done = s.read();
    s.write(body + "\r\n.\r\n");
    const r = await done;
    if (r.code !== 250) throw new SmtpError(`信没被接收：${r.code} ${r.lines.join(" ").slice(0, 200)}`, r.code);
    await s.cmd("QUIT", [221]).catch(() => {});
    return r.lines.join(" ");
  } finally {
    s.close();
  }
}

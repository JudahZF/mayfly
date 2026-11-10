#!/usr/bin/env bun
/**
 * Turns a raw browser HAR export of a Maytas session into a folder that is safe for an agent to read.
 * Secrets are removed; page content (personal data) is kept on purpose.
 *
 * Usage: bun tools/scrub-har.ts <path-to-har> [--out capture/scrubbed]
 */
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type NameValue = { name: string; value: string };
type HarEntry = {
  startedDateTime: string;
  resourceType: string | undefined;
  request: {
    method: string;
    url: string;
    headers: NameValue[];
    cookies: NameValue[];
    postData: { mimeType: string; text: string | undefined; params: NameValue[] } | undefined;
  };
  response: {
    status: number;
    headers: NameValue[];
    cookies: NameValue[];
    content: { size: number; mimeType: string; text: string | undefined; encoding: string | undefined };
  };
};

const REDACTED = "[REDACTED]";
const USERNAME = "[USERNAME]";
// Short values (for example a cookie "1" or "true") would wreck the output if replaced everywhere.
const MIN_FIELD_SECRET = 3;
const MIN_COOKIE_SECRET = 8;

const STATIC_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);
const STATIC_PATH = /\.(m?js|css|png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|otf|eot|map)$/i;
const STATIC_MIME = /^(image|font)\/|javascript|ecmascript|text\/css/i;

// ---------- HAR parsing ----------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function requireString(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new Error(`HAR: ${where}.${key} must be a string`);
  return v;
}

const optionalString = (o: Record<string, unknown>, key: string): string | undefined =>
  typeof o[key] === "string" ? o[key] : undefined;

function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`HAR: ${where} must be an object`);
  return v;
}

/** Missing lists become empty; a missing `value` becomes "" (Firefox omits it for file params). */
function nameValues(v: unknown, where: string): NameValue[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`HAR: ${where} must be an array`);
  return v.map((item, i) => {
    const o = record(item, `${where}[${i}]`);
    return { name: requireString(o, "name", `${where}[${i}]`), value: optionalString(o, "value") ?? "" };
  });
}

function parseEntry(raw: unknown, i: number): HarEntry {
  const where = `entries[${i}]`;
  const e = record(raw, where);
  const req = record(e.request, `${where}.request`);
  const res = record(e.response, `${where}.response`);
  const content = record(res.content, `${where}.response.content`);
  const post = req.postData === undefined ? undefined : record(req.postData, `${where}.request.postData`);
  return {
    startedDateTime: requireString(e, "startedDateTime", where),
    resourceType: optionalString(e, "_resourceType"),
    request: {
      method: requireString(req, "method", `${where}.request`),
      url: requireString(req, "url", `${where}.request`),
      headers: nameValues(req.headers, `${where}.request.headers`),
      cookies: nameValues(req.cookies, `${where}.request.cookies`),
      postData: post && {
        mimeType: optionalString(post, "mimeType") ?? "",
        text: optionalString(post, "text"),
        params: nameValues(post.params, `${where}.request.postData.params`),
      },
    },
    response: {
      status: typeof res.status === "number" ? res.status : 0,
      headers: nameValues(res.headers, `${where}.response.headers`),
      cookies: nameValues(res.cookies, `${where}.response.cookies`),
      content: {
        size: typeof content.size === "number" ? content.size : -1,
        mimeType: optionalString(content, "mimeType") ?? "",
        text: optionalString(content, "text"),
        encoding: optionalString(content, "encoding"),
      },
    },
  };
}

function parseHar(json: unknown): HarEntry[] {
  const log = record(record(json, "root").log, "log");
  if (!Array.isArray(log.entries)) throw new Error("HAR: log.entries must be an array");
  return log.entries.map(parseEntry);
}

// ---------- Redaction ----------

type SecretKind = "password" | "username" | "token";

function secretKind(name: string): SecretKind | undefined {
  if (/password|passwd|pwd/i.test(name)) return "password";
  if (/user_?name/i.test(name)) return "username";
  if (/requestverificationtoken|csrf|xsrf/i.test(name)) return "token";
  return undefined;
}

function decodeForm(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Redacts known secret locations and collects each secret value for a final literal sweep. */
class Scrubber {
  readonly secrets = new Map<string, string>();

  keep(value: string, placeholder: string, minLength: number): void {
    if (value.length >= minLength) this.secrets.set(value, placeholder);
  }

  field(name: string, value: string): string {
    const kind = secretKind(name);
    if (!kind) return value;
    const placeholder = kind === "username" ? USERNAME : REDACTED;
    this.keep(value, placeholder, MIN_FIELD_SECRET);
    return placeholder;
  }

  cookiePair(pair: string): string {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    this.keep(pair.slice(eq + 1).trim(), REDACTED, MIN_COOKIE_SECRET);
    return `${pair.slice(0, eq)}=${REDACTED}`;
  }

  cookies(list: NameValue[]): void {
    for (const c of list) this.keep(c.value, REDACTED, MIN_COOKIE_SECRET);
  }

  header({ name, value }: NameValue): NameValue {
    const lower = name.toLowerCase();
    if (lower === "cookie") {
      return { name, value: value.split(/;\s*/).map((c) => this.cookiePair(c)).join("; ") };
    }
    if (lower === "set-cookie") {
      // Firefox joins several Set-Cookie headers with newlines.
      const lines = value.split("\n").map((line) => {
        const [first = "", ...attrs] = line.split(";");
        return [this.cookiePair(first), ...attrs].join(";");
      });
      return { name, value: lines.join("\n") };
    }
    if (lower === "authorization" || lower === "proxy-authorization") {
      // Keep the bare credential too ("Bearer abc" -> "abc"), in case a page echoes it alone.
      this.keep(value, REDACTED, MIN_COOKIE_SECRET);
      this.keep(value.slice(value.indexOf(" ") + 1), REDACTED, MIN_COOKIE_SECRET);
      return { name, value: REDACTED };
    }
    if (lower === "location" || lower === "referer") return { name, value: this.url(value) };
    return { name, value: this.field(name, value) };
  }

  urlencoded(text: string): { text: string; fields: string[] } {
    const fields: string[] = [];
    const pairs = text.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = decodeForm(pair.slice(0, eq));
      fields.push(name);
      return secretKind(name) ? `${pair.slice(0, eq)}=${this.field(name, decodeForm(pair.slice(eq + 1)))}` : pair;
    });
    return { text: pairs.join("&"), fields };
  }

  url(raw: string): string {
    const q = raw.indexOf("?");
    if (q < 0) return raw;
    const hash = raw.indexOf("#", q);
    const end = hash < 0 ? raw.length : hash;
    return raw.slice(0, q + 1) + this.urlencoded(raw.slice(q + 1, end)).text + raw.slice(end);
  }

  multipart(text: string): { text: string; fields: string[] } {
    const fields: string[] = [];
    const part = /(Content-Disposition:[^\r\n]*?\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi;
    const out = text.replace(part, (_m, head: string, name: string, value: string) => {
      fields.push(name);
      return head + this.field(name, value);
    });
    return { text: out, fields };
  }

  jsonValue(v: unknown, key: string | undefined): unknown {
    if (typeof v === "string" && key !== undefined) return this.field(key, v);
    if (Array.isArray(v)) return v.map((x) => this.jsonValue(x, key));
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.jsonValue(x, k)]));
    return v;
  }

  /** Pretty-prints valid JSON (easier to read); leaves invalid JSON for the literal sweep. */
  json(text: string): { text: string; fields: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { text, fields: [] };
    }
    return {
      text: JSON.stringify(this.jsonValue(parsed, undefined), null, 2),
      fields: isRecord(parsed) ? Object.keys(parsed) : [],
    };
  }

  /** Redacts value/content of <input> and <meta> tags whose name is a secret field. */
  html(text: string): string {
    return text.replace(/<(?:input|meta)\b[^>]*>/gi, (tag) => {
      const name = /\sname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
      if (!name || !secretKind(name)) return tag;
      return tag.replace(
        /(\s(?:value|content)\s*=\s*)(["'])(.*?)\2/gi,
        (_m, pre: string, quote: string, value: string) => pre + quote + this.field(name, value) + quote,
      );
    });
  }

  body(mimeType: string, text: string): { text: string; fields: string[] } {
    if (/x-www-form-urlencoded/i.test(mimeType)) return this.urlencoded(text);
    if (/multipart\/form-data/i.test(mimeType)) return this.multipart(text);
    if (/json/i.test(mimeType)) return this.json(text);
    if (/html/i.test(mimeType)) return { text: this.html(text), fields: [] };
    return { text, fields: [] };
  }

  /** Replaces every remaining literal occurrence of each collected secret, in its common encodings. */
  sweeper(): (text: string) => string {
    const replacements = new Map<string, string>();
    for (const [secret, placeholder] of this.secrets) {
      const uri = encodeURIComponent(secret);
      for (const variant of [secret, uri, uri.replace(/%20/g, "+"), Bun.escapeHTML(secret), JSON.stringify(secret).slice(1, -1)]) {
        replacements.set(variant, placeholder);
      }
    }
    const ordered = [...replacements].sort(([a], [b]) => b.length - a.length);
    return (text) => ordered.reduce((acc, [variant, placeholder]) => acc.replaceAll(variant, placeholder), text);
  }
}

// ---------- Output ----------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isStatic(e: HarEntry): boolean {
  if (e.resourceType && STATIC_TYPES.has(e.resourceType)) return true;
  let path = e.request.url;
  try {
    path = new URL(e.request.url).pathname;
  } catch {}
  return STATIC_PATH.test(path) || STATIC_MIME.test(e.response.content.mimeType);
}

const baseMime = (mime: string) => mime.split(";")[0]?.trim() || "-";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function responseText(content: HarEntry["response"]["content"]): string {
  const text = content.text ?? "";
  return content.encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
}

function extension(mime: string): string {
  if (/html/i.test(mime)) return "html";
  if (/json/i.test(mime)) return "json";
  return "txt";
}

function scrub(entries: HarEntry[]) {
  const first = entries.find((e) => e.resourceType === "document" || /html/i.test(e.response.content.mimeType));
  if (!first) throw new Error("HAR has no document request, so the Maytas host is unknown.");
  const host = hostOf(first.request.url);
  const sameHost = entries.filter((e) => hostOf(e.request.url) === host);
  const kept = sameHost.filter((e) => !isStatic(e));

  const scrubber = new Scrubber();
  const files = new Map<string, string>();
  const t0 = Date.parse(kept[0]?.startedDateTime ?? "");
  const rows = [
    `# Scrubbed capture of ${host}`,
    "",
    "| # | t | method | path | status | request type | response type | size | request fields |",
    "|---|---|---|---|---|---|---|---|---|",
  ];

  kept.forEach((e, i) => {
    const n = String(i + 1).padStart(3, "0");
    const { request: req, response: res } = e;
    const url = scrubber.url(req.url);
    const headers = req.headers.map((h) => scrubber.header(h));
    res.headers.forEach((h) => scrubber.header(h));
    scrubber.cookies(req.cookies);
    scrubber.cookies(res.cookies);

    const post = req.postData;
    const reqType = post?.mimeType || req.headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    let fields: string[] = [];
    if (post && (post.text || post.params.length)) {
      const raw = post.text ?? post.params.map((p) => `${p.name}=${p.value}`).join("&");
      const body = scrubber.body(reqType, raw);
      post.params.forEach((p) => scrubber.field(p.name, p.value));
      fields = post.params.length ? post.params.map((p) => p.name) : body.fields;
      const head = [`${req.method} ${url}`, ...headers.map((h) => `${h.name}: ${h.value}`)];
      files.set(`${n}-request.txt`, `${head.join("\n")}\n\n${body.text}\n`);
    }

    const resType = res.content.mimeType;
    const resBody = responseText(res.content);
    if (resBody) files.set(`${n}-response.${extension(resType)}`, scrubber.body(resType, resBody).text);

    const offset = Number.isNaN(t0) ? "-" : `+${((Date.parse(e.startedDateTime) - t0) / 1000).toFixed(1)}s`;
    const parsed = URL.parse(url);
    const path = parsed ? parsed.pathname + parsed.search : url;
    const size = res.content.size >= 0 ? res.content.size : resBody.length;
    rows.push(
      `| ${n} | ${offset} | ${req.method} | \`${path}\` | ${res.status} | ${baseMime(reqType)} | ${baseMime(resType)} | ${formatSize(size)} | ${fields.join(", ") || "-"} |`,
    );
  });
  files.set("index.md", `${rows.join("\n")}\n`);

  const sweep = scrubber.sweeper();
  for (const [name, text] of files) files.set(name, sweep(text));
  return {
    files,
    stats: {
      host,
      total: entries.length,
      otherHost: entries.length - sameHost.length,
      static: sameHost.length - kept.length,
      kept: kept.length,
      secrets: scrubber.secrets.size,
    },
  };
}

// ---------- CLI ----------

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: "string" } },
  allowPositionals: true,
});
const harPath = positionals[0];
if (!harPath || positionals.length > 1) {
  console.error("Usage: bun tools/scrub-har.ts <path-to-har> [--out capture/scrubbed]");
  process.exit(1);
}

// The default is anchored to the repository's git-ignored capture/ folder, whatever the cwd.
// Any other location must be asked for with an explicit --out.
const outDir = values.out ? resolve(values.out) : resolve(import.meta.dir, "..", "capture", "scrubbed");
const existing = await readdir(outDir).catch(() => []);
if (existing.length > 0) {
  console.error(`Output folder ${outDir} is not empty. Delete it or pass another --out.`);
  process.exit(1);
}

const { files, stats } = scrub(parseHar(await Bun.file(harPath).json()));
await mkdir(outDir, { recursive: true });
await Promise.all([...files].map(([name, text]) => Bun.write(join(outDir, name), text)));

console.log(
  [
    `Host: ${stats.host}`,
    `Entries: ${stats.total} total, ${stats.kept} kept, ${stats.static} static assets dropped, ${stats.otherHost} other hosts dropped`,
    `Secret values collected and redacted: ${stats.secrets}`,
    `Wrote ${files.size} files to ${outDir}`,
    "",
    "WARNING: the output still holds personal data (names, logged activities).",
    "Keep it in the git-ignored capture/ folder. Do not commit it.",
  ].join("\n"),
);

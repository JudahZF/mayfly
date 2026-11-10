/**
 * Read-only probe of the real Maytas Hub, for mapping its pages.
 * Signs in with MAYTAS_USERNAME and MAYTAS_PASSWORD from .env, fetches each given path
 * with GET only, saves the replies to capture/live/, then signs out.
 *
 *   bun tools/probe-maytas.ts /etrack/Home "/etrack/CustomTab/Learner?componentId=..."
 *
 * The output holds personal data. It stays in the git-ignored capture/ folder.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = new URL(`${(process.env.MAYTAS_URL ?? "https://apprenticeships.chi.ac.uk/etrack").replace(/\/+$/, "")}/`);
const username = process.env.MAYTAS_USERNAME;
const password = process.env.MAYTAS_PASSWORD;
if (!username || !password) throw new Error("MAYTAS_USERNAME and MAYTAS_PASSWORD must be set in .env");

const outDir = join(import.meta.dir, "../capture/live");
mkdirSync(outDir, { recursive: true });

const gapMs = 2_000;
const jar = new Map<string, string>();
let count = 0;
let lastAt = 0;

function absorbCookies(res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
}

async function send(url: URL, init: RequestInit = {}) {
  if (url.host !== base.host) throw new Error(`Refusing a request to another host: ${url.host}`);
  const wait = lastAt + gapMs - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastAt = Date.now();
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
      Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...init.headers,
    },
  });
  absorbCookies(res);
  return res;
}

/** GET with redirects followed by hand, so every hop keeps the cookies. */
async function get(path: string) {
  let url = new URL(path, base);
  for (let hop = 0; hop < 6; hop++) {
    const res = await send(url);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return { url, status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  }
  throw new Error(`Too many redirects from ${path}`);
}

async function save(name: string, page: Awaited<ReturnType<typeof get>>) {
  const file = `${String(++count).padStart(2, "0")}-${name.replace(/[^\w.-]+/g, "_").slice(0, 60)}.${page.type.includes("json") ? "json" : "html"}`;
  await Bun.write(join(outDir, file), page.body.replaceAll(password ?? "\0", "[REDACTED]"));
  const signedOut = /id="frmLogin"/.test(page.body);
  console.log(`${file}  ${page.status}  ${page.url.pathname}${page.url.search}  ${page.body.length} B${signedOut ? "  (LOGIN PAGE: not signed in)" : ""}`);
}

const login = await get("Login");
const token = login.body.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/)?.[1];
if (!token) throw new Error("No __RequestVerificationToken on the login page");

const form = new FormData();
form.set("__RequestVerificationToken", token);
form.set("Username", username);
form.set("Password", password);
const posted = await send(new URL("Login/Login", base), { method: "POST", body: form });
const next = posted.headers.get("location");
console.log(`sign-in: ${posted.status}${next ? ` -> ${new URL(next, base).pathname}` : ""}`);

try {
  await save("landing", await get(next ?? "Home"));
  for (const path of process.argv.slice(2)) await save(path, await get(path));
} finally {
  const out = await get("Account/Logout").catch(() => null);
  console.log(`sign-out: ${out ? `${out.status} ${out.url.pathname}` : "failed"}`);
}

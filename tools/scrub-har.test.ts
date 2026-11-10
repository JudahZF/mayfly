import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = "https://maytas.example.ac.uk";
const PASSWORD = "Hunter2!& secret";
const USERNAME = "student4711";
const SESSION_COOKIE = "sess-0f9a8b7c6d5e4f3a";
const AUTH_COOKIE = "auth-CfDJ8Mq1x2y3z4";
const FORM_TOKEN = "formtok-AbCdEf123456";
const COOKIE_TOKEN = "cookietok-ZyXwVu987654";
const HEADER_TOKEN = "headertok-Qq11Ww22Ee33";
const SECRETS = [PASSWORD, encodeURIComponent(PASSWORD), USERNAME, SESSION_COOKIE, AUTH_COOKIE, FORM_TOKEN, COOKIE_TOKEN, HEADER_TOKEN];

const headers = (pairs: Record<string, string>) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

const entry = (
  offsetMs: number,
  request: { method: string; path: string; headers?: Record<string, string>; postData?: { mimeType: string; text: string } },
  response: { status: number; mimeType: string; text?: string; encoding?: string; headers?: Record<string, string> },
  resourceType?: string,
) => ({
  startedDateTime: new Date(Date.UTC(2026, 10, 9, 9) + offsetMs).toISOString(),
  _resourceType: resourceType,
  request: { ...request, url: request.path.startsWith("http") ? request.path : HOST + request.path, headers: headers(request.headers ?? {}), cookies: [] },
  response: {
    status: response.status,
    headers: headers(response.headers ?? {}),
    cookies: [],
    content: { size: response.text?.length ?? 0, mimeType: response.mimeType, text: response.text, encoding: response.encoding },
  },
});

const boundary = "----WebKitFormBoundaryX";
const signInForm = Object.entries({ Username: USERNAME, Password: PASSWORD, __RequestVerificationToken: FORM_TOKEN })
  .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  .join("")
  .concat(`--${boundary}--\r\n`);
const echoPage = `<h1>Welcome ${USERNAME}</h1><script>var s="${SESSION_COOKIE}",p="${PASSWORD}",q="${encodeURIComponent(PASSWORD)}";</script><!-- ${AUTH_COOKIE} ${HEADER_TOKEN} -->`;

const har = {
  log: {
    version: "1.2",
    entries: [
      entry(
        0,
        { method: "GET", path: "/etrack/Login" },
        {
          status: 200,
          mimeType: "text/html",
          text: `<input name="__RequestVerificationToken" type="hidden" value="${FORM_TOKEN}">`,
          headers: { "Set-Cookie": `ASP.NET_SessionId=${SESSION_COOKIE}; path=/; HttpOnly\n__RequestVerificationToken=${COOKIE_TOKEN}; path=/` },
        },
        "document",
      ),
      entry(150, { method: "GET", path: "/etrack/Scripts/jquery.min.js" }, { status: 200, mimeType: "application/javascript", text: "/* jquery */" }, "script"),
      entry(
        2000,
        {
          method: "POST",
          path: "/etrack/Login",
          headers: { Cookie: `ASP.NET_SessionId=${SESSION_COOKIE}; __RequestVerificationToken=${COOKIE_TOKEN}` },
          postData: { mimeType: `multipart/form-data; boundary=${boundary}`, text: signInForm },
        },
        { status: 302, mimeType: "text/html", headers: { "Set-Cookie": `.AspNet.ApplicationCookie=${AUTH_COOKIE}; path=/; secure`, Location: "/etrack/Home" } },
      ),
      entry(
        2500,
        { method: "GET", path: "/etrack/Home", headers: { Cookie: `.AspNet.ApplicationCookie=${AUTH_COOKIE}` } },
        { status: 200, mimeType: "text/html; charset=utf-8", encoding: "base64", text: Buffer.from(echoPage).toString("base64") },
      ),
      entry(
        3000,
        {
          method: "POST",
          path: `/etrack/api/Activities?pwd=${encodeURIComponent(PASSWORD)}`,
          headers: { RequestVerificationToken: HEADER_TOKEN, Authorization: `Bearer ${AUTH_COOKIE}` },
          postData: { mimeType: "application/json", text: JSON.stringify({ week: 3, password: PASSWORD }) },
        },
        { status: 200, mimeType: "application/json", text: JSON.stringify({ activities: [{ title: "Lab report", by: USERNAME }], token: COOKIE_TOKEN }) },
      ),
      entry(3100, { method: "GET", path: "https://other.example.com/track" }, { status: 200, mimeType: "text/plain", text: `tracker ${SESSION_COOKIE}` }),
    ],
  },
};

test("scrub leaves no secret in any output file, drops static assets and indexes kept requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scrub-har-"));
  const harPath = join(dir, "session.har");
  const outDir = join(dir, "out");
  await Bun.write(harPath, JSON.stringify(har));

  const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "scrub-har.ts"), harPath, "--out", outDir]);
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);

  const names = (await readdir(outDir)).sort();
  expect(names).toEqual(["001-response.html", "002-request.txt", "003-response.html", "004-request.txt", "004-response.json", "index.md"]);

  for (const name of names) {
    const text = await Bun.file(join(outDir, name)).text();
    for (const secret of SECRETS) expect({ name, secret, leaked: text.includes(secret) }).toEqual({ name, secret, leaked: false });
  }

  const index = await Bun.file(join(outDir, "index.md")).text();
  const rows = index.split("\n").filter((line) => /^\| \d{3} /.test(line));
  expect(rows.map((row) => row.split("|")[4]?.trim())).toEqual([
    "`/etrack/Login`",
    "`/etrack/Login`",
    "`/etrack/Home`",
    "`/etrack/api/Activities?pwd=[REDACTED]`",
  ]);
  expect(rows[1]).toContain("Username, Password, __RequestVerificationToken");
  expect(index).not.toContain("jquery");
});

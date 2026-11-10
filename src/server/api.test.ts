import { describe, expect, test } from "bun:test";
import { setup } from "./testing";

const token = "a-long-test-token-0123456789";

describe("without a token", () => {
  test("only loopback Host names are served (DNS rebinding)", async () => {
    const { app } = await setup();
    const status = async (host: string) => (await app.request("/api/state", { headers: { host } })).status;
    expect(await status("localhost:4747")).toBe(200);
    expect(await status("127.0.0.1:5173")).toBe(200);
    expect(await status("[::1]:4747")).toBe(200);
    expect(await status("evil.example:4747")).toBe(403);
    expect(await status("localhost.evil.example")).toBe(403);
  });

  test("a cross-site Origin is refused", async () => {
    const { app } = await setup();
    const status = async (origin: string) =>
      (await app.request("/api/settings", { method: "PATCH", headers: { host: "localhost:4747", origin, "content-type": "application/json" }, body: JSON.stringify({ syncPaused: true }) })).status;
    expect(await status("http://evil.example")).toBe(403);
    expect(await status("http://localhost:5173")).toBe(403);
    expect(await status("http://localhost:4747")).toBe(200);
  });

  test("/mcp is guarded too", async () => {
    const { app } = await setup();
    expect((await app.request("/mcp", { method: "POST", headers: { host: "evil.example" } })).status).toBe(403);
  });
});

describe("with a token", () => {
  test("every API request needs the token as a Bearer header or the session cookie", async () => {
    const { app } = await setup({ token });
    const host = "mayfly.tailnet.example";
    const get = (headers: Record<string, string>) => app.request("/api/state", { headers: { host, ...headers } });

    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get({ authorization: `Bearer ${token}` })).status).toBe(200);

    const refused = await app.request("/api/session", { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    expect(refused.status).toBe(401);
    const session = await app.request("/api/session", { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const cookie = session.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect((await get({ cookie: cookie.split(";")[0] ?? "" })).status).toBe(200);
  });

  test("a cross-site Origin is refused even with the token", async () => {
    const { app } = await setup({ token });
    const res = await app.request("/api/state", { headers: { host: "mayfly.tailnet.example", origin: "https://evil.example", authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});

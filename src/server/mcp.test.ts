import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { sampleInput, setup } from "./testing";

/** An MCP client whose requests go straight to the app, through the guards. */
async function connect(app: Hono) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:4747/mcp"), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost:4747");
      return await app.request(url, { ...init, headers });
    },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { ...result, text };
  };
  return { client, call };
}

const draftsRefusal = /drafts/;

describe("drafts mode (default)", () => {
  test("an added entry is a draft, and a retry makes no second entry", async () => {
    const t = await setup();
    const { call } = await connect(t.app);
    const first = await call("add_entries", { entries: [sampleInput()] });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("created as draft");

    const retry = await call("add_entries", { entries: [sampleInput()] });
    expect(retry.text).toContain("already existed as draft");
    expect(t.entries.list({ q: sampleInput().describe })).toHaveLength(1);
  });

  test("approve, and change or delete of an entry in Maytas, are refused and name the mode", async () => {
    const t = await setup();
    const { call } = await connect(t.app);
    const [synced] = t.entries.list({ state: "inMaytas" });
    if (!synced) throw new Error("setup has no entry in Maytas");

    for (const refused of [
      await call("approve_drafts", { ids: "all" }),
      await call("update_entry", { id: synced.id, hours: 1 }),
      await call("delete_entry", { id: synced.id }),
    ]) {
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(draftsRefusal);
      expect(refused.structuredContent).toMatchObject({ error: "notAllowed", mode: "drafts" });
    }
    expect(t.entries.get(synced.id)).toMatchObject({ ok: true, value: { centihours: synced.centihours, deletedAt: null } });
  });
});

test("in full access an added entry is queued", async () => {
  const t = await setup();
  t.entries.setSettings("app", { agentMode: "fullAccess" });
  const { call } = await connect(t.app);
  const added = await call("add_entries", { entries: [sampleInput()] });
  expect(added.text).toContain("created as queued");
});

test("the tool list is fixed, and no tool can change the agent mode", async () => {
  const { app } = await setup();
  const { client } = await connect(app);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    ["add_entries", "approve_drafts", "delete_entry", "get_progress", "get_review_prep", "list_entries", "list_ksbs", "update_entry"].sort(),
  );
});

test("with a token, /mcp without the token is rejected", async () => {
  const token = "a-long-test-token-0123456789";
  const { app } = await setup({ token });
  const post = (headers: Record<string, string>) =>
    app.request("/mcp", {
      method: "POST",
      headers: { host: "mayfly.tailnet.example", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200);
});

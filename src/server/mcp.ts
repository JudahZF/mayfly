import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import { entryFields, syncStateNames } from "../shared/entry";
import type { Bridge } from "./bridge";
import { type Db, readProfile } from "./db";
import type { Entry } from "./db/schema";
import type { Entries, Refusal, Result } from "./entries";
import { prepText, reviewPrep } from "./reviews";

const instructions = `Mayfly logs off-the-job (OTJ) training hours for an apprentice. Each entry is evidence for a funded apprenticeship and goes to the university portal (Maytas), where a coach and auditors read it.
- Estimate hours conservatively. Never round up.
- A task that repeats counts only the first time. Before you add, call list_entries to look for a repeat. Do not add a repeat.
- The reflection must say what the person learned, not only what they did.
- Call get_progress to see the agent mode. In drafts mode each entry you add is a draft: the person approves it in the Mayfly app before it goes to Maytas. In full access an entry goes to the queue for Maytas at once.
- You cannot change the agent mode or settings. When a tool is refused, tell the person the reason that the tool gives.
- To help with a progress review form, call get_review_prep. Use only its facts and entry text. Never invent activities or learning.`;

const hours = (centihours: number | null) => (centihours === null ? null : centihours / 100);

const view = (e: Entry) => ({
  id: e.id,
  date: e.date,
  startTime: e.startTime,
  hours: e.centihours / 100,
  where: e.where,
  method: e.method,
  describe: e.describe,
  reflect: e.reflect,
  anythingElse: e.anythingElse,
  ksbs: e.ksbs,
  source: e.source,
  state: e.sync.state,
});

const progressHours = (p: ReturnType<Entries["progress"]>) => ({
  inMaytas: hours(p.confirmedCentihours),
  onTheWay: hours(p.pendingCentihours),
  drafts: hours(p.draftCentihours),
  needsAttention: hours(p.needsYouCentihours),
  target: hours(p.targetCentihours),
  remaining: hours(p.remainingCentihours),
  pacePerWeek: hours(p.pacePerWeekCentihours),
});

const line = (e: Entry) => `${e.id} ${e.date} ${e.centihours / 100} h [${e.sync.state}] ${e.describe}`;

const reply = (text: string, structuredContent: Record<string, unknown>, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent,
  isError,
});

const refused = (r: Refusal) => reply(r.message, { ...r }, true);

const entryReply = (verb: string, result: Result<Entry>) =>
  result.ok ? reply(`${verb}: ${line(result.value)}`, { entry: view(result.value) }) : refused(result);

type McpDeps = { db: Db; entries: Entries; bridge: Bridge; now: () => number };

/** The MCP door into the store. Every tool calls the entries service as actor `agent`, so the service enforces the agent mode. */
function createServer({ db, entries, bridge, now }: McpDeps) {
  const server = new McpServer({ name: "mayfly", version: "0.1.0" }, { instructions });
  const profile = readProfile(db);
  const allowed = profile
    ? `Allowed values. where: ${profile.wheres.join(" | ")}. method: ${profile.methods.join(" | ")}. ksbs (codes): ${profile.ksbs.map((k) => k.code).join(", ")}.`
    : "The Maytas profile is not loaded yet, so entries cannot be added until the first sync.";

  server.registerTool(
    "get_progress",
    {
      description: "Hours against the target, the weekly pace needed, the bridge status and the current agent mode. Hours are in hours (2.5 = 2 h 30 min).",
      annotations: { readOnlyHint: true },
    },
    () => {
      const p = entries.progress();
      const { agentMode } = entries.settings();
      const result = {
        agentMode,
        standard: p.standard,
        endDate: p.endDate,
        hours: progressHours(p),
        bridge: bridge.status(),
      };
      const h = result.hours;
      return reply(
        [
          `Agent mode: ${agentMode}.`,
          `${h.inMaytas} h in Maytas, ${h.onTheWay} h on the way, ${h.drafts} h in drafts. Target ${h.target ?? "unknown"} h, ${h.remaining ?? "unknown"} h left.`,
          `Pace needed: ${h.pacePerWeek ?? "unknown"} h per week until ${p.endDate ?? "an unknown end date"}.`,
          `Bridge: ${result.bridge.state}${result.bridge.reason ? ` (${result.bridge.reason})` : ""}.`,
        ].join("\n"),
        result,
      );
    },
  );

  server.registerTool(
    "list_entries",
    {
      description:
        "Search entries, newest first. Use it to look for a repeat before you add: a task that repeats counts only the first time. q matches the describe, reflect and anything-else text.",
      inputSchema: {
        q: z.string().trim().min(1).optional(),
        from: z.iso.date().optional().describe("First date, YYYY-MM-DD"),
        to: z.iso.date().optional().describe("Last date, YYYY-MM-DD"),
        state: z.enum(syncStateNames).optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit, ...filter }) => {
      const all = entries.list(filter);
      const shown = all.slice(0, limit);
      const more = all.length > shown.length ? `\n${all.length - shown.length} more. Narrow the search or raise the limit.` : "";
      return reply(
        shown.length > 0 ? shown.map(line).join("\n") + more : "No entries match.",
        { total: all.length, entries: shown.map(view) },
      );
    },
  );

  server.registerTool(
    "list_ksbs",
    {
      description: "The KSBs (knowledge, skills and behaviours) of the apprenticeship standard, with the hours of evidence for each. Drafts do not count.",
      annotations: { readOnlyHint: true },
    },
    () => {
      const ksbs = entries.ksbCoverage().map(({ centihours, ...k }) => ({ ...k, hours: centihours / 100 }));
      return reply(
        ksbs.length > 0 ? ksbs.map((k) => `${k.code} ${k.hours} h (${k.entries} entries): ${k.text}`).join("\n") : "The Maytas profile is not loaded yet.",
        { ksbs },
      );
    },
  );

  server.registerTool(
    "get_review_prep",
    {
      description: `The facts for the next progress review, to help the learner write the Progress Review Form in Maytas (sections 1 to 6: what they did, what they learned and how it developed their KSBs, and how they applied it).
It gives the review date and staff member, the date to submit the form by (five working days before the review), the form status, and, since the last completed review: hours, hours per method, KSBs with and without evidence, and every entry with its describe and reflect text.
- Use only these facts. Do not invent activities, learning, results or KSB evidence.
- When you write what the learner did or learned, quote or closely follow the entry text. If something is missing, ask the learner; do not fill the gap.
- A KSB with no evidence has no evidence. Say so; do not stretch another entry to cover it.
- The learner completes and submits the form in Maytas. Mayfly cannot write it.
- Progress reviews do not count as off-the-job hours. Do not log the review as an entry.
Hours are in hours (2.5 = 2 h 30 min).`,
      annotations: { readOnlyHint: true },
    },
    () => {
      const prep = reviewPrep(db, entries, now());
      const { since, progress } = prep;
      return reply(prepText(prep), {
        ...prep,
        since: {
          after: since.after,
          hoursInMaytas: hours(since.confirmedCentihours),
          hoursOnTheWay: hours(since.pendingCentihours),
          hoursThatNeedTheUser: hours(since.needsYouCentihours),
          entryCount: since.entryCount,
          methods: since.methods.map(({ centihours, ...m }) => ({ ...m, hours: hours(centihours) })),
          ksbs: since.ksbs.map(({ centihours, ...k }) => ({ ...k, hours: hours(centihours) })),
          ksbsWithoutEvidence: since.ksbsWithoutEvidence,
          entries: since.entries.map(({ centihours, ...e }) => ({ ...e, hours: hours(centihours) })),
        },
        progress: { standard: progress.standard, endDate: progress.endDate, hours: progressHours(progress) },
      });
    },
  );

  server.registerTool(
    "add_entries",
    {
      description: `Adds one or more OTJ entries. These entries are evidence for a funded apprenticeship.
- Estimate hours conservatively.
- A task that repeats counts only the first time: call list_entries first and do not add a repeat.
- reflect must say what the person learned.
- In drafts mode each entry is a draft until the person approves it in the Mayfly app. In full access it goes to the queue for Maytas at once.
- A retry is safe: an entry with the same date, hours and describe text returns the existing entry and makes no second one.
The reply gives, per entry: created or already existed, the state (draft or queued), the ID and any warnings, or the issues that stopped it.
${allowed}`,
      inputSchema: { entries: z.array(entryFields).min(1).max(100) },
    },
    ({ entries: inputs }) => {
      const results = entries.add("agent", inputs).map((o, index) =>
        o.ok
          ? { index, ok: true as const, created: o.value.created, entry: view(o.value.entry), warnings: o.value.warnings }
          : { index, ...o },
      );
      const text = results.map((r) =>
        r.ok
          ? `#${r.index} ${r.created ? "created" : "already existed"} as ${r.entry.state}: ${r.entry.id}${r.warnings.map((w) => `\n  warning: ${w}`).join("")}`
          : `#${r.index} not added: ${r.message}`,
      );
      return reply(text.join("\n"), { results }, results.some((r) => !r.ok));
    },
  );

  server.registerTool(
    "update_entry",
    {
      description: `Changes the fields you give on one entry. In drafts mode an agent can change only a draft. ${allowed}`,
      inputSchema: { id: z.string().min(1), ...entryFields.partial().shape },
    },
    ({ id, ...changes }) => entryReply("Updated", entries.update("agent", id, changes)),
  );

  server.registerTool(
    "delete_entry",
    {
      description: "Deletes one entry. In drafts mode an agent can delete only a draft. An entry in Maytas is deleted there through the queue.",
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) => entryReply("Deleted", entries.remove("agent", id)),
  );

  server.registerTool(
    "approve_drafts",
    {
      description: 'Sends drafts to the queue for Maytas. Give a list of IDs, or "all". Allowed only in full access; in drafts mode the person approves drafts in the app.',
      inputSchema: { ids: z.union([z.array(z.string().min(1)).min(1), z.literal("all")]) },
    },
    ({ ids }) => {
      const result = entries.approve("agent", ids);
      if (!result.ok) return refused(result);
      return reply(
        result.value.length > 0 ? `Queued ${result.value.length}:\n${result.value.map(line).join("\n")}` : "No drafts matched.",
        { approved: result.value.map(view) },
      );
    },
  );

  return server;
}

/** `/mcp`: stateless Streamable HTTP with plain JSON replies. A new server and transport serve each request. */
export function mcpRoutes(deps: McpDeps) {
  return new Hono()
    .post("/mcp", async (c) => {
      const server = createServer(deps);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close();
      }
    })
    .all("/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405));
}

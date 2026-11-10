import { zValidator } from "@hono/zod-validator";
import { and, desc, lt } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { agentModes, entryFields, resolveInput, syncStateNames } from "../shared/entry";
import type { Maytas } from "../maytas/types";
import { type Bridge, type BridgeConfig, createBridge } from "./bridge";
import { type Db, readProfile, readReviews } from "./db";
import { bridgeLog, type Entry } from "./db/schema";
import { createEntries, type Entries, type Result } from "./entries";
import { loopbackNames } from "./loopback";
import { mcpRoutes } from "./mcp";
import type { Clock } from "./outbox";
import { prepText, reviewPrep } from "./reviews";

const tokenCookie = "mayfly_token";

const refusalStatus = { notAllowed: 403, busy: 409, notFound: 404, invalid: 400, conflict: 409 } as const;

const digest = (text: string) => createHash("sha256").update(text).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * Guards `/api/*` and `/mcp`.
 * - An `Origin` header must name the same host as `Host` (blocks cross-site requests).
 * - With a token: a Bearer header or the session cookie must carry it.
 * - Without a token: `Host` must be a loopback name (blocks DNS rebinding).
 */
export function guard(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (origin !== undefined && URL.parse(origin)?.host !== host) {
      return c.json({ error: "forbidden", message: "Cross-site request refused" }, 403);
    }
    if (token === undefined) {
      const hostname = URL.parse(`http://${host}`)?.hostname ?? "";
      if (!loopbackNames.has(hostname)) return c.json({ error: "forbidden", message: "Unknown host" }, 403);
      return next();
    }
    if (c.req.path === "/api/session") return next();
    const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const presented = bearer ?? getCookie(c, tokenCookie);
    if (presented === undefined || !sameSecret(presented, token)) {
      return c.json({ error: "unauthorized", message: "A valid access token is required" }, 401);
    }
    return next();
  };
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function toCsv(rows: Entry[]) {
  const header = ["id", "date", "startTime", "hours", "where", "method", "describe", "reflect", "anythingElse", "ksbs", "source", "state", "maytasRowId", "deletedAt"];
  const lines = rows.map((e) =>
    [
      e.id,
      e.date,
      e.startTime,
      (e.centihours / 100).toFixed(2),
      e.where,
      e.method,
      e.describe,
      e.reflect,
      e.anythingElse,
      e.ksbs.join(" "),
      e.source,
      e.sync.state,
      e.maytasRowId,
      e.deletedAt === null ? null : new Date(e.deletedAt).toISOString(),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

const idParam = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  q: z.string().trim().min(1).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  state: z.enum(syncStateNames).optional(),
  includeDeleted: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/** The typed routes for the web app. `AppType` comes from this chain. */
function apiRoutes({ db, entries, bridge, token, now }: { db: Db; entries: Entries; bridge: Bridge; token: string | undefined; now: () => number }) {
  return new Hono()
    .basePath("/api")
    .post("/session", zValidator("json", z.object({ token: z.string().min(1) })), (c) => {
      if (token === undefined) return c.json({ ok: true }, 200);
      if (!sameSecret(c.req.valid("json").token, token)) return c.json({ ok: false }, 401);
      setCookie(c, tokenCookie, token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 60 * 60 * 24 * 365 });
      return c.json({ ok: true }, 200);
    })
    .get("/state", (c) =>
      c.json({ progress: entries.progress(), bridge: bridge.status(), settings: entries.settings(), profile: readProfile(db) }, 200),
    )
    .get("/ksbs", (c) => c.json({ ksbs: entries.ksbCoverage() }, 200))
    .get("/reviews", (c) => {
      const prep = reviewPrep(db, entries, now());
      return c.json({ reviews: readReviews(db), prep, summary: prepText(prep) }, 200);
    })
    .get("/entries", zValidator("query", listQuery), (c) => c.json({ entries: entries.list(c.req.valid("query")) }, 200))
    .post(
      "/entries",
      zValidator("json", z.object({ entries: z.array(entryFields).min(1).max(1000) })),
      (c) => c.json({ results: entries.add("app", c.req.valid("json").entries) }, 200),
    )
    .post(
      "/entries/approve",
      zValidator("json", z.object({ ids: z.union([z.array(z.string().min(1)), z.literal("all")]) })),
      (c) => reply(c, entries.approve("app", c.req.valid("json").ids)),
    )
    .get("/entries/:id", zValidator("param", idParam), (c) => reply(c, entries.get(c.req.valid("param").id)))
    .patch("/entries/:id", zValidator("param", idParam), zValidator("json", entryFields.partial()), (c) =>
      reply(c, entries.update("app", c.req.valid("param").id, c.req.valid("json"))),
    )
    .delete("/entries/:id", zValidator("param", idParam), (c) => reply(c, entries.remove("app", c.req.valid("param").id)))
    .post("/entries/:id/restore", zValidator("param", idParam), (c) =>
      reply(c, entries.restore("app", c.req.valid("param").id)),
    )
    .post("/entries/:id/resolve", zValidator("param", idParam), zValidator("json", resolveInput), (c) =>
      reply(c, entries.resolve("app", c.req.valid("param").id, c.req.valid("json"))),
    )
    .patch(
      "/settings",
      zValidator("json", z.object({ agentMode: z.enum(agentModes).optional(), syncPaused: z.boolean().optional() })),
      (c) => reply(c, entries.setSettings("app", c.req.valid("json"))),
    )
    .post("/bridge/resume", (c) => {
      bridge.resume();
      return c.json(bridge.status(), 200);
    })
    .post("/sync", (c) => {
      bridge.requestReconcile();
      return c.json(bridge.status(), 202);
    })
    .get(
      "/log",
      zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() })),
      (c) => {
        const { limit, before } = c.req.valid("query");
        const log = db
          .select()
          .from(bridgeLog)
          .where(and(before === undefined ? undefined : lt(bridgeLog.id, before)))
          .orderBy(desc(bridgeLog.id))
          .limit(limit)
          .all();
        return c.json({ log }, 200);
      },
    )
    .get("/export.csv", (c) => {
      c.header("content-type", "text/csv; charset=utf-8");
      c.header("content-disposition", `attachment; filename="mayfly-entries.csv"`);
      return c.body(toCsv(entries.list({ includeDeleted: true })));
    });
}

function reply<T extends {}>(c: Context, result: Result<T>) {
  return result.ok ? c.json(result.value, 200) : c.json(result, refusalStatus[result.error]);
}

export type AppType = ReturnType<typeof apiRoutes>;

export type MayflyDeps = {
  db: Db;
  maytas: Maytas;
  token?: string;
  clock?: Clock;
  bridgeConfig?: Partial<BridgeConfig>;
};

/** Builds the store services, the bridge and the HTTP app with `/api` and `/mcp`. The caller adds the web files. */
export function createMayfly({ db, maytas, token, clock, bridgeConfig }: MayflyDeps) {
  const bridge = createBridge({ db, maytas, clock, config: bridgeConfig });
  const now = clock?.now ?? Date.now;
  const entries = createEntries({ db, now, onQueued: bridge.wake });
  const app = new Hono();
  app.use("/api/*", guard(token));
  app.use("/mcp", guard(token));
  app.use("/mcp/*", guard(token));
  app.route("/", apiRoutes({ db, entries, bridge, token, now }));
  app.route("/", mcpRoutes({ db, entries, bridge, now }));
  app.all("/api/*", (c) => c.json({ error: "notFound", message: `No route ${c.req.method} ${c.req.path}` }, 404));
  return { app, entries, bridge };
}

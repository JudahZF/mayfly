import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { agentModes, type SyncState } from "../../shared/entry";
import type { MaytasProfile, MaytasReview } from "../../maytas/types";

export const sources = ["app", "agent", "maytas"] as const;
export type Source = (typeof sources)[number];

export const entries = sqliteTable(
  "entries",
  {
    id: text().primaryKey(),
    date: text().notNull(),
    startTime: text(),
    centihours: integer().notNull(),
    where: text().notNull(),
    method: text().notNull(),
    describe: text().notNull(),
    reflect: text().notNull(),
    anythingElse: text(),
    ksbs: text({ mode: "json" }).$type<string[]>().notNull(),
    source: text({ enum: sources }).notNull(),
    maytasRowId: text().unique(),
    fingerprint: text().notNull(),
    sync: text({ mode: "json" }).$type<SyncState>().notNull(),
    /** Set when the entry is deleted. The entry stays, so a wrong delete can be sent again. */
    deletedAt: integer(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex("entries_live_fingerprint").on(t.fingerprint).where(sql`${t.deletedAt} is null`),
    index("entries_date").on(t.date),
  ],
);

export const profile = sqliteTable("profile", {
  id: integer().primaryKey(),
  data: text({ mode: "json" }).$type<MaytasProfile>().notNull(),
  updatedAt: integer().notNull(),
});

/** A cache of the Maytas engagements. Each reconcile replaces it. */
export const reviews = sqliteTable("reviews", {
  id: integer().primaryKey(),
  data: text({ mode: "json" }).$type<MaytasReview[]>().notNull(),
  updatedAt: integer().notNull(),
});

export const settings = sqliteTable("settings", {
  id: integer().primaryKey(),
  agentMode: text({ enum: agentModes }).notNull().default("drafts"),
  /** Set by the user. While true the bridge does not sign in at all. */
  syncPaused: integer({ mode: "boolean" }).notNull().default(false),
  /** Set by the bridge when it must stop until the user resumes it. */
  bridgePausedReason: text(),
  bridgePausedAt: integer(),
  signInFailures: integer().notNull().default(0),
  lastReconcileAt: integer(),
});

export const bridgeLog = sqliteTable(
  "bridge_log",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: integer().notNull(),
    kind: text().notNull(),
    entryId: text(),
    source: text({ enum: ["app", "agent", "bridge"] }).notNull(),
    detail: text().notNull(),
  },
  (t) => [index("bridge_log_at").on(t.at)],
);

export type Entry = typeof entries.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type LogEntry = typeof bridgeLog.$inferSelect;

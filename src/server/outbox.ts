import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { contentOf, fingerprint, sameContent, type SyncOp, type SyncState } from "../shared/entry";
import { type MaytasRow, type MaytasSession, MaytasUnavailable } from "../maytas/types";
import { type Db, writeLog } from "./db";
import { type Entry, entries } from "./db/schema";

/** Time for the bridge. `sleep` resolves after `ms`, or at once when `signal` aborts. */
export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

export const realClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    }),
};

export type OutboxConfig = {
  /** How long to wait for a write before going to look. The reply is ignored either way. */
  writeTimeoutMs: number;
  /** The wait before each of the two reads that check a write. */
  checkGapMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** An edit that Maytas still does not show after this many attempts needs the user. */
  maxEditAttempts: number;
};

export type OutboxContext = {
  db: Db;
  clock: Clock;
  config: OutboxConfig;
  session: MaytasSession;
  /** Runs one Maytas request with the minimum gap and a time-out. */
  request: <T>(call: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  /** Waits until the next request may start. */
  waitForGap: () => Promise<void>;
  /** True when the user or the bridge paused sync. No write starts then. */
  stopped: () => boolean;
};

export type AddMatch =
  | { kind: "none" }
  | { kind: "one"; row: MaytasRow }
  | { kind: "many"; rows: MaytasRow[] }
  | { kind: "near"; rows: MaytasRow[] };

/**
 * Finds the Maytas row of an entry that has no `rowId` yet, among rows that no other
 * entry owns. Once a write may have reached Maytas, a row with the same date and hours
 * but other text is a stop sign too: Maytas may have changed the text on save.
 */
export function matchAdd(entry: Pick<Entry, "fingerprint" | "date" | "centihours">, unlinked: MaytasRow[], mayHaveWritten: boolean): AddMatch {
  const exact = unlinked.filter((r) => fingerprint(r) === entry.fingerprint);
  const [first] = exact;
  if (exact.length > 1) return { kind: "many", rows: exact };
  if (first) return { kind: "one", row: first };
  if (!mayHaveWritten) return { kind: "none" };
  const near = unlinked.filter((r) => r.date === entry.date && r.centihours === entry.centihours);
  return near.length > 0 ? { kind: "near", rows: near } : { kind: "none" };
}

export const backoff = (attempt: number, baseMs: number, maxMs: number) => Math.min(maxMs, baseMs * 2 ** attempt);

const stateOf = sql<string>`json_extract(${entries.sync}, '$.state')`;

/** At start: an entry that was in `writing` may have reached Maytas. It is checked, never written again blind. */
export function recoverCrashed(db: Db, now: number) {
  for (const entry of db.select().from(entries).where(eq(stateOf, "writing")).all()) {
    if (entry.sync.state !== "writing") continue;
    const { op, attempts } = entry.sync;
    db.update(entries)
      .set({ sync: { state: "checking", op, attempts, since: now, replied: true } })
      .where(eq(entries.id, entry.id))
      .run();
    writeLog(db, { at: now, kind: "recover", entryId: entry.id, source: "bridge", detail: `${op} was in writing at start: check before any write` });
  }
}

export const nextDue = (db: Db, now: number) =>
  db
    .select()
    .from(entries)
    .where(
      or(
        eq(stateOf, "checking"),
        and(eq(stateOf, "queued"), sql`json_extract(${entries.sync}, '$.notBefore') <= ${now}`),
      ),
    )
    .orderBy(asc(entries.createdAt))
    .get();

export const nextQueuedAt = (db: Db) =>
  db
    .select({ at: sql<number>`min(json_extract(${entries.sync}, '$.notBefore'))` })
    .from(entries)
    .where(eq(stateOf, "queued"))
    .get()?.at ?? null;

/** Rows of the grid that no entry other than `selfId` owns. */
function unlinkedRows(db: Db, grid: MaytasRow[], selfId: string) {
  const owned = new Set(
    db
      .select({ rowId: entries.maytasRowId })
      .from(entries)
      .where(and(isNotNull(entries.maytasRowId), ne(entries.id, selfId)))
      .all()
      .map((r) => r.rowId),
  );
  return grid.filter((r) => !owned.has(r.rowId));
}

type Done = { done: true; sync: SyncState; rowId?: string | null; detail: string };
type Outcome = Done | { done: false };

const needsYou = (op: SyncOp, reason: string, rows: MaytasRow[] = []): Done => ({
  done: true,
  sync: { state: "needsYou", op, reason, rows },
  detail: reason,
});

/** What the grid says about an entry after a write may have happened. */
function judge(ctx: OutboxContext, entry: Entry, op: SyncOp, attempts: number, grid: MaytasRow[], mayHaveWritten: boolean): Outcome {
  const now = ctx.clock.now();
  const confirmed = (rowId: string, detail: string): Outcome => ({ done: true, sync: { state: "inMaytas", confirmedAt: now }, rowId, detail });

  if (op === "add") {
    const match = matchAdd(entry, unlinkedRows(ctx.db, grid, entry.id), mayHaveWritten);
    switch (match.kind) {
      case "none":
        return { done: false };
      case "one":
        return sameContent(match.row, entry)
          ? confirmed(match.row.rowId, `found once as ${match.row.rowId}`)
          : needsYou("add", "Maytas has this row, but some fields differ from Mayfly.", [match.row]);
      case "many":
        return needsYou("add", `Maytas has ${match.rows.length} rows with this date, hours and text.`, match.rows);
      case "near":
        return needsYou("add", "Maytas has a row with this date and hours but other text. It may have changed the text on save.", match.rows);
    }
  }

  const row = grid.find((r) => r.rowId === entry.maytasRowId);
  if (op === "delete") {
    return row ? { done: false } : { done: true, sync: { state: "removed", at: now }, detail: "row is absent from Maytas" };
  }
  if (!row) return needsYou("add", "The row is no longer in Maytas.");
  if (sameContent(row, entry)) return confirmed(row.rowId, "row has the new content");
  if (attempts >= ctx.config.maxEditAttempts) {
    return needsYou("edit", `Maytas still shows other content after ${attempts} attempts.`, [row]);
  }
  return { done: false };
}

function apply(ctx: OutboxContext, entry: Entry, outcome: Done) {
  ctx.db
    .update(entries)
    .set({
      sync: outcome.sync,
      ...(outcome.rowId === undefined ? {} : { maytasRowId: outcome.rowId }),
      updatedAt: ctx.clock.now(),
    })
    .where(eq(entries.id, entry.id))
    .run();
  writeLog(ctx.db, { at: ctx.clock.now(), kind: outcome.sync.state, entryId: entry.id, source: "bridge", detail: outcome.detail });
}

const freshEntry = (db: Db, id: string) => db.select().from(entries).where(eq(entries.id, id)).get();

/** Moves one due entry (queued or checking) as far as the grid allows. */
export async function processEntry(ctx: OutboxContext, entry: Entry) {
  const { sync } = entry;
  if (sync.state === "checking") return check(ctx, entry, sync);
  if (sync.state !== "queued") return;
  const { op, attempts } = sync;

  // The user may change the entry during a wait. Then the next pass starts again.
  const changed = () => JSON.stringify(freshEntry(ctx.db, entry.id)) !== JSON.stringify(entry);

  const grid = await ctx.request(() => ctx.session.listOtj());
  if (changed()) return;

  let target = entry;
  if (op === "delete" && entry.maytasRowId === null) {
    const match = matchAdd(entry, unlinkedRows(ctx.db, grid, entry.id), true);
    if (match.kind === "none") return apply(ctx, entry, { done: true, sync: { state: "removed", at: ctx.clock.now() }, detail: "never reached Maytas" });
    if (match.kind !== "one" || !sameContent(match.row, entry)) {
      const rows = match.kind === "one" ? [match.row] : match.rows;
      return apply(ctx, entry, needsYou("delete", "Maytas has rows that could be this entry, but Mayfly cannot be sure. Delete the right one in Maytas.", rows));
    }
    target = { ...entry, maytasRowId: match.row.rowId };
  }

  const looked = judge(ctx, target, op, attempts, grid, attempts > 0);
  if (looked.done) return apply(ctx, target, looked);

  // Nothing may happen between this check and the write, so the wait comes first.
  await ctx.waitForGap();
  if (ctx.stopped() || changed()) return;
  // Not an attempt: the entry stays queued, and the bridge waits like for an outage.
  if (ctx.session.saving?.()) throw new MaytasUnavailable("An earlier save to Maytas has not finished yet.");

  ctx.db
    .update(entries)
    .set({ sync: { state: "writing", op, attempts, startedAt: ctx.clock.now() }, maytasRowId: target.maytasRowId })
    .where(eq(entries.id, entry.id))
    .run();
  writeLog(ctx.db, { at: ctx.clock.now(), kind: `write.${op}`, entryId: entry.id, source: "bridge", detail: `attempt ${attempts + 1}` });

  const content = contentOf(target);
  const rowId = target.maytasRowId ?? "";
  const write = op === "add" ? () => ctx.session.addOtj(content) : op === "edit" ? () => ctx.session.editOtj(rowId, content) : () => ctx.session.deleteOtj(rowId);
  // One request. Resolve, reject and hang all mean the same thing: go and look.
  let replied = false;
  const tracked = () => write().finally(() => (replied = true));
  await ctx.request(tracked, ctx.config.writeTimeoutMs).catch(() => {});

  const checking = { state: "checking", op, attempts, since: ctx.clock.now(), replied } as const;
  ctx.db.update(entries).set({ sync: checking }).where(eq(entries.id, entry.id)).run();
  const saved = freshEntry(ctx.db, entry.id);
  if (saved) await check(ctx, saved, checking);
}

/**
 * Two spaced reads of the grid. Not found after both: back to the queue with a longer wait.
 * An add that got no reply is not sent again: the first request can still arrive.
 */
async function check(ctx: OutboxContext, entry: Entry, { op, attempts, replied }: Extract<SyncState, { state: "checking" }>) {
  for (let read = 0; read < 2; read++) {
    await ctx.clock.sleep(ctx.config.checkGapMs);
    const grid = await ctx.request(() => ctx.session.listOtj());
    const outcome = judge(ctx, entry, op, attempts, grid, true);
    if (outcome.done) return apply(ctx, entry, outcome);
  }
  if (op === "add" && !replied) {
    return apply(ctx, entry, needsYou("add", "Maytas did not reply to the save, and the row is not there yet. The save can still arrive. Look in Maytas, then retry."));
  }
  const wait = backoff(attempts, ctx.config.retryBaseMs, ctx.config.retryMaxMs);
  apply(ctx, entry, {
    done: true,
    sync: { state: "queued", op, attempts: attempts + 1, notBefore: ctx.clock.now() + wait },
    detail: `not found after two reads, retry in ${Math.round(wait / 1000)} s`,
  });
}

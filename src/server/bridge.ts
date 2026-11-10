import { eq, isNull, sql } from "drizzle-orm";
import { contentOf, fingerprint, sameContent, type SyncState } from "../shared/entry";
import {
  LayoutChanged,
  type Maytas,
  type MaytasReview,
  type MaytasRow,
  type MaytasSession,
  MaytasUnavailable,
  SignInFailed,
} from "../maytas/types";
import { type Db, readSettings, writeLog, writeSettings } from "./db";
import { entries, profile, reviews } from "./db/schema";
import {
  backoff,
  type Clock,
  matchAdd,
  nextDue,
  nextQueuedAt,
  type OutboxConfig,
  processEntry,
  realClock,
  recoverCrashed,
} from "./outbox";

export type BridgeConfig = OutboxConfig & {
  /** Minimum gap between two Maytas requests, so the rate stays below a person's. */
  requestGapMs: number;
  /** Time-out for reads, sign-in and sign-out. */
  requestTimeoutMs: number;
  unavailableBaseMs: number;
  unavailableMaxMs: number;
  reconcileEveryMs: number;
};

export const defaultBridgeConfig: BridgeConfig = {
  requestGapMs: 2_000,
  requestTimeoutMs: 60_000,
  writeTimeoutMs: 60_000,
  checkGapMs: 15_000,
  retryBaseMs: 60_000,
  retryMaxMs: 3_600_000,
  maxEditAttempts: 3,
  unavailableBaseMs: 60_000,
  unavailableMaxMs: 1_800_000,
  reconcileEveryMs: 86_400_000,
};

export type ReconcileReport = { imported: number; linked: number; vanished: number; changed: number; flagged: number };

const idleCheckMs = 60_000;

/** The one writer to Maytas: a single loop that handles one entry at a time. */
export function createBridge({
  db,
  maytas,
  clock = realClock,
  config: overrides = {},
}: {
  db: Db;
  maytas: Maytas;
  clock?: Clock;
  config?: Partial<BridgeConfig>;
}) {
  const config = { ...defaultBridgeConfig, ...overrides };
  const log = (kind: string, detail: string, entryId: string | null = null) =>
    writeLog(db, { at: clock.now(), kind, entryId, source: "bridge", detail });

  let running = false;
  let working = false;
  let signedIn = false;
  let reconcileRequested = false;
  let waitUntil = 0;
  let unavailableCount = 0;
  let lastError: string | null = null;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let woken = false;
  let sleeper: AbortController | null = null;

  async function waitForGap() {
    const gap = lastRequestAt + config.requestGapMs - clock.now();
    if (gap > 0) await clock.sleep(gap);
  }

  async function request<T>(call: () => Promise<T>, timeoutMs = config.requestTimeoutMs): Promise<T> {
    await waitForGap();
    lastRequestAt = clock.now();
    const settled = new AbortController();
    const timeout = clock.sleep(timeoutMs, settled.signal).then(() => {
      throw new MaytasUnavailable(`No reply from Maytas in ${Math.round(timeoutMs / 1000)} s`);
    });
    try {
      return await Promise.race([call(), timeout]);
    } finally {
      settled.abort();
    }
  }

  function pause(reason: string) {
    writeSettings(db, { bridgePausedReason: reason, bridgePausedAt: clock.now() });
    log("pause", reason);
  }

  function handleError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    if (error instanceof SignInFailed) {
      const failures = readSettings(db).signInFailures + 1;
      writeSettings(db, { signInFailures: failures });
      log("signIn.failed", `${message} (${failures} in a row)`);
      if (failures >= 2) pause("Sign-in failed two times in a row. Check the Maytas username and password, then resume.");
      else waitUntil = clock.now() + config.unavailableBaseMs;
    } else if (error instanceof LayoutChanged) {
      pause(message);
    } else if (error instanceof MaytasUnavailable) {
      const wait = backoff(unavailableCount++, config.unavailableBaseMs, config.unavailableMaxMs);
      waitUntil = clock.now() + wait;
      log("unavailable", `${message}. Next try in ${Math.round(wait / 1000)} s`);
    } else {
      pause(`Unexpected error: ${message}`);
    }
  }

  function saveProfile(data: Awaited<ReturnType<MaytasSession["getProfile"]>>) {
    const at = clock.now();
    db.insert(profile)
      .values({ id: 1, data, updatedAt: at })
      .onConflictDoUpdate({ target: profile.id, set: { data, updatedAt: at } })
      .run();
  }

  function saveReviews(data: MaytasReview[]) {
    const at = clock.now();
    db.insert(reviews)
      .values({ id: 1, data, updatedAt: at })
      .onConflictDoUpdate({ target: reviews.id, set: { data, updatedAt: at } })
      .run();
  }

  async function reconcile(session: MaytasSession): Promise<ReconcileReport> {
    saveProfile(await request(() => session.getProfile()));
    // Reviews are a nicety: any failure keeps the last list, and the OTJ sync goes on.
    try {
      saveReviews(await request(() => session.listReviews()));
    } catch (error) {
      log("reviews.failed", error instanceof Error ? error.message : String(error));
    }
    const grid = await request(() => session.listOtj());
    const at = clock.now();
    const report: ReconcileReport = { imported: 0, linked: 0, vanished: 0, changed: 0, flagged: 0 };
    const byRowId = new Map(grid.map((r) => [r.rowId, r]));
    const setSync = (id: string, sync: SyncState, extra: { maytasRowId?: string } = {}) =>
      db.update(entries).set({ sync, ...extra, updatedAt: at }).where(eq(entries.id, id)).run();
    const flag = (id: string, sync: Extract<SyncState, { state: "needsYou" }>) => {
      setSync(id, sync);
      log("reconcile.flag", sync.reason, id);
      report.flagged++;
    };

    const all = db.select().from(entries).all();
    for (const entry of all) {
      if (entry.maytasRowId === null) continue;
      const row = byRowId.get(entry.maytasRowId);
      if (entry.sync.state === "inMaytas" && entry.deletedAt === null) {
        if (!row) {
          report.vanished++;
          flag(entry.id, { state: "needsYou", op: "add", reason: "The row vanished from Maytas.", rows: [] });
        } else if (!sameContent(row, entry)) {
          report.changed++;
          flag(entry.id, { state: "needsYou", op: "edit", reason: "The row changed in Maytas.", rows: [row] });
        }
      } else if (entry.sync.state === "removed" && row) {
        flag(entry.id, { state: "needsYou", op: "delete", reason: "A deleted entry is in Maytas again.", rows: [row] });
      }
    }

    const owned = new Set(all.flatMap((e) => (e.maytasRowId === null ? [] : [e.maytasRowId])));
    let unlinked = grid.filter((r) => !owned.has(r.rowId));
    const take = (rows: MaytasRow[]) => {
      const taken = new Set(rows.map((r) => r.rowId));
      unlinked = unlinked.filter((r) => !taken.has(r.rowId));
    };

    // Rows that an open question or a pending delete may own are not imported.
    for (const { sync, maytasRowId, fingerprint: fp } of all) {
      if (sync.state === "needsYou") take(sync.rows);
      else if (maytasRowId === null && sync.state === "queued" && sync.op === "delete") take(unlinked.filter((r) => fingerprint(r) === fp));
    }

    for (const entry of all) {
      if (entry.maytasRowId !== null || entry.deletedAt !== null) continue;
      const { sync } = entry;
      const pendingAdd = (sync.state === "queued" || sync.state === "checking") && sync.op === "add";
      if (!pendingAdd && sync.state !== "draft") continue;
      const mayHaveWritten = sync.state === "checking" || (sync.state === "queued" && sync.attempts > 0);
      const match = matchAdd(entry, unlinked, mayHaveWritten);
      if (match.kind === "none") continue;
      if (match.kind === "one" && sameContent(match.row, entry)) {
        setSync(entry.id, { state: "inMaytas", confirmedAt: at }, { maytasRowId: match.row.rowId });
        log("reconcile.link", `linked to ${match.row.rowId}`, entry.id);
        report.linked++;
        take([match.row]);
      } else {
        const rows = match.kind === "one" ? [match.row] : match.rows;
        flag(entry.id, { state: "needsYou", op: "add", reason: "Maytas has a row that could be this entry, but it differs.", rows });
        take(rows);
      }
    }

    const liveFingerprints = new Set(
      db.select({ fp: entries.fingerprint }).from(entries).where(isNull(entries.deletedAt)).all().map((r) => r.fp),
    );
    for (const row of unlinked) {
      const content = contentOf(row);
      let fp = fingerprint(content);
      if (liveFingerprints.has(fp)) {
        log("reconcile.duplicate", `Maytas has more than one row for ${fp}. Row ${row.rowId} is imported as a separate entry.`);
        fp = `${fp}#${row.rowId}`;
      }
      liveFingerprints.add(fp);
      const id = crypto.randomUUID();
      db.insert(entries)
        .values({ id, ...content, source: "maytas", maytasRowId: row.rowId, fingerprint: fp, sync: { state: "inMaytas", confirmedAt: at }, createdAt: at, updatedAt: at })
        .run();
      report.imported++;
    }

    writeSettings(db, { lastReconcileAt: at });
    log("reconcile", JSON.stringify(report));
    return report;
  }

  const stopped = () => {
    const s = readSettings(db);
    return s.syncPaused || s.bridgePausedReason !== null;
  };

  /** One pass: sign in only if there is work, do all due work, sign out. */
  async function tick() {
    if (working || stopped() || clock.now() < waitUntil) return;
    const { lastReconcileAt } = readSettings(db);
    const reconcileDue = reconcileRequested || lastReconcileAt === null || clock.now() - lastReconcileAt >= config.reconcileEveryMs;
    if (!reconcileDue && !nextDue(db, clock.now())) return;

    working = true;
    let session: MaytasSession | null = null;
    try {
      // The user may pause sync during the wait. Then the bridge must not take the one session.
      await waitForGap();
      if (stopped()) return;
      session = await request(() => maytas.signIn());
      signedIn = true;
      writeSettings(db, { signInFailures: 0 });
      log("signIn", "signed in");
      if (reconcileDue) {
        reconcileRequested = false;
        await reconcile(session);
      }
      const ctx = { db, clock, config, session, request, waitForGap, stopped };
      for (let entry = nextDue(db, clock.now()); entry && !stopped(); entry = nextDue(db, clock.now())) {
        await processEntry(ctx, entry);
      }
      unavailableCount = 0;
      lastError = null;
    } catch (error) {
      handleError(error);
    } finally {
      if (session) {
        const open = session;
        await request(() => open.signOut()).catch(() => {});
        log("signOut", "signed out");
      }
      signedIn = false;
      working = false;
    }
  }

  function wake() {
    woken = true;
    sleeper?.abort();
  }

  async function loop() {
    while (running) {
      await tick();
      if (!running) break;
      if (woken) {
        woken = false;
        continue;
      }
      const dueAt = Math.min(nextQueuedAt(db) ?? Number.POSITIVE_INFINITY, waitUntil || Number.POSITIVE_INFINITY);
      const delay = Math.max(250, Math.min(idleCheckMs, dueAt - clock.now()));
      sleeper = new AbortController();
      await clock.sleep(delay, sleeper.signal);
      sleeper = null;
      woken = false;
    }
  }

  return {
    tick,
    wake,

    start() {
      if (running) return;
      recoverCrashed(db, clock.now());
      running = true;
      void loop();
    },

    stop() {
      running = false;
      wake();
    },

    /** Runs a reconcile at the next pass, then the normal work. */
    requestReconcile() {
      reconcileRequested = true;
      waitUntil = 0;
      wake();
    },

    /** Clears a pause set by the bridge (sign-in failures, layout change). */
    resume() {
      writeSettings(db, { bridgePausedReason: null, bridgePausedAt: null, signInFailures: 0 });
      log("resume", "resumed by the user");
      waitUntil = 0;
      wake();
    },

    status() {
      const s = readSettings(db);
      const counts = Object.fromEntries(
        db
          .select({ state: sql<string>`json_extract(${entries.sync}, '$.state')`, n: sql<number>`count(*)` })
          .from(entries)
          .groupBy(sql`1`)
          .all()
          .map((r) => [r.state, r.n]),
      );
      const state: BridgeState = s.syncPaused
        ? "syncPaused"
        : s.bridgePausedReason !== null
          ? "paused"
          : working
            ? "working"
            : waitUntil > clock.now()
              ? "waiting"
              : "idle";
      return {
        state,
        reason: s.bridgePausedReason ?? lastError,
        pausedAt: s.bridgePausedAt,
        waitUntil: waitUntil > clock.now() ? waitUntil : null,
        signedIn,
        lastReconcileAt: s.lastReconcileAt,
        counts,
      };
    },
  };
}

export type BridgeState = "syncPaused" | "paused" | "working" | "waiting" | "idle";
export type Bridge = ReturnType<typeof createBridge>;

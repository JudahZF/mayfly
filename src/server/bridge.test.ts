import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { contentOf, fingerprint } from "../shared/entry";
import { sampleReviews } from "../maytas/fake";
import { readReviews, readSettings } from "./db";
import { entries } from "./db/schema";
import { type MaytasSession, MaytasUnavailable } from "../maytas/types";
import { recoverCrashed } from "./outbox";
import { sampleInput, setup } from "./testing";

const hour = 3_600_000;

async function withQueuedAdd() {
  const t = await setup();
  const [outcome] = t.entries.add("app", [sampleInput()]);
  if (!outcome?.ok) throw new Error("add failed");
  const id = outcome.value.entry.id;
  const entry = () => {
    const result = t.entries.get(id);
    if (!result.ok) throw new Error("entry missing");
    return result.value;
  };
  const rowsInMaytas = () => t.maytas.rows.filter((r) => fingerprint(r) === entry().fingerprint);
  const addWrites = () => t.maytas.writes.filter((w) => w.kind === "add").length;
  const content = () => contentOf(entry());
  return { ...t, id, entry, rowsInMaytas, addWrites, content };
}

/** An add whose write got a reply but no row, so it waits in the queue as "may have reached Maytas". */
async function withUnconfirmedAdd() {
  const t = await withQueuedAdd();
  t.maytas.writeFaults.push("notSaved");
  await t.bridge.tick();
  expect(t.entry().sync).toMatchObject({ state: "queued", op: "add", attempts: 1 });
  return t;
}

/** Runs `hook` one time, while the bridge waits for its next read of the grid. */
function duringNextGridRead(t: Awaited<ReturnType<typeof setup>>, hook: () => void) {
  const signIn = t.maytas.signIn.bind(t.maytas);
  let pending: (() => void) | null = hook;
  spyOn(t.maytas, "signIn").mockImplementation(async (): Promise<MaytasSession> => {
    const session = await signIn();
    return {
      ...session,
      listOtj: async () => {
        pending?.();
        pending = null;
        return session.listOtj();
      },
    };
  });
}

describe("add", () => {
  test("a normal add is written once and confirmed from the grid", async () => {
    const t = await withQueuedAdd();
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.entry().maytasRowId).toBe(t.rowsInMaytas()[0]?.rowId ?? "missing");
    expect(t.addWrites()).toBe(1);
    expect(t.maytas.signedIn).toBe(false);
  });

  test("a row already in Maytas is linked without a write", async () => {
    const t = await withQueuedAdd();
    const { startTime: _, ...content } = { ...t.entry(), anythingElse: null };
    t.maytas.insert(content);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.addWrites()).toBe(0);
  });

  test("a save with no reply and no row is not sent again, because it can still arrive", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("hang");
    await t.bridge.tick();
    expect(t.entry().sync).toMatchObject({ state: "needsYou", op: "add" });
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.addWrites()).toBe(1);

    t.maytas.insert(t.content());
    expect(t.entries.resolve("app", t.id, { action: "retry" }).ok).toBe(true);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.rowsInMaytas()).toHaveLength(1);
    expect(t.addWrites()).toBe(1);
  });

  test("an entry that the user changes while the grid loads is not confirmed from the old row", async () => {
    const t = await withQueuedAdd();
    t.maytas.insert(t.content());
    duringNextGridRead(t, () => t.entries.update("app", t.id, { reflect: "Changed while the grid loaded" }));
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("needsYou");
    expect(t.rowsInMaytas()[0]?.reflect).not.toBe(t.entry().reflect);
  });

  test("a hang with the row saved is confirmed with no second write", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("hangAfterSave");
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.addWrites()).toBe(1);
  });

  test("a dropped reply with the row saved is confirmed with no second write", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("dropReply");
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.rowsInMaytas()).toHaveLength(1);
    expect(t.addWrites()).toBe(1);
  });

  test("a row saved twice needs the user, and nothing is deleted", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("saveTwice");
    await t.bridge.tick();
    const sync = t.entry().sync;
    expect(sync.state).toBe("needsYou");
    if (sync.state === "needsYou") expect(sync.rows).toHaveLength(2);
    expect(t.rowsInMaytas()).toHaveLength(2);
    expect(t.maytas.writes.map((w) => w.kind)).toEqual(["add"]);
  });

  test("text that Maytas changed on save needs the user, with no second write", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("alterText");
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("needsYou");
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.addWrites()).toBe(1);
  });

  test("a reply with the row not saved is retried and ends with exactly one row", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("notSaved", "notSaved");
    for (let i = 0; i < 4; i++) {
      await t.bridge.tick();
      t.clock.advance(hour);
    }
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.rowsInMaytas()).toHaveLength(1);
    expect(t.addWrites()).toBe(3);
  });

  test("a session that ends mid-write is checked after a new sign-in, then retried once", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("sessionEnds");
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("checking");
    expect(t.bridge.status().state).toBe("waiting");

    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.entry().sync).toMatchObject({ state: "queued", attempts: 1 });

    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.rowsInMaytas()).toHaveLength(1);
    expect(t.addWrites()).toBe(2);
  });
});

describe("crash recovery", () => {
  const crashInWriting = async () => {
    const t = await withQueuedAdd();
    t.db.update(entries)
      .set({ sync: { state: "writing", op: "add", attempts: 0, startedAt: t.clock.now() } })
      .where(eq(entries.id, t.id))
      .run();
    return t;
  };

  test("an entry left in writing whose row arrived is confirmed with no write", async () => {
    const t = await crashInWriting();
    t.maytas.insert({ ...t.entry(), anythingElse: null });
    recoverCrashed(t.db, t.clock.now());
    expect(t.entry().sync.state).toBe("checking");
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.addWrites()).toBe(0);
  });

  test("an entry left in writing whose row did not arrive is checked first, then written once", async () => {
    const t = await crashInWriting();
    recoverCrashed(t.db, t.clock.now());
    await t.bridge.tick();
    expect(t.addWrites()).toBe(0);
    expect(t.entry().sync).toMatchObject({ state: "queued", attempts: 1 });
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.addWrites()).toBe(1);
    expect(t.rowsInMaytas()).toHaveLength(1);
  });
});

describe("edit and delete", () => {
  const inMaytas = async () => {
    const t = await withQueuedAdd();
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    return t;
  };

  test("an edit is written to the same row and confirmed from its new content", async () => {
    const t = await inMaytas();
    const rowId = t.entry().maytasRowId;
    const updated = t.entries.update("app", t.id, { hours: 3, reflect: "Refresh must not race the logout" });
    expect(updated.ok && updated.value.sync).toMatchObject({ state: "queued", op: "edit" });
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    const row = t.maytas.rows.find((r) => r.rowId === rowId);
    expect(row).toMatchObject({ centihours: 300, reflect: "Refresh must not race the logout" });
    expect(t.maytas.writes.filter((w) => w.kind === "edit")).toHaveLength(1);
  });

  test("an edit that Maytas did not apply is sent again", async () => {
    const t = await inMaytas();
    t.entries.update("app", t.id, { hours: 3 });
    t.maytas.writeFaults.push("notSaved");
    await t.bridge.tick();
    expect(t.entry().sync).toMatchObject({ state: "queued", op: "edit", attempts: 1 });
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.maytas.writes.filter((w) => w.kind === "edit")).toHaveLength(2);
  });

  test("a delete is confirmed when the row is absent, and the entry is kept", async () => {
    const t = await inMaytas();
    const rowId = t.entry().maytasRowId;
    t.entries.remove("app", t.id);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("removed");
    expect(t.entry().deletedAt).not.toBeNull();
    expect(t.maytas.rows.some((r) => r.rowId === rowId)).toBe(false);

    const restored = t.entries.restore("app", t.id);
    expect(restored.ok && restored.value.sync).toMatchObject({ state: "queued", op: "add" });
  });

  test("a delete of an unconfirmed add does not delete a row whose other fields differ", async () => {
    const t = await withUnconfirmedAdd();
    const other = t.maytas.insert({ ...t.content(), reflect: "A different activity" });
    t.entries.remove("app", t.id);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("needsYou");
    expect(t.maytas.rows).toContainEqual(other);
    expect(t.maytas.writes.filter((w) => w.kind === "delete")).toHaveLength(0);
  });
});

describe("pauses and sessions", () => {
  test("two failed sign-ins in a row pause the bridge until the user resumes it", async () => {
    const t = await withQueuedAdd();
    t.maytas.signInFails = true;
    const signIn = spyOn(t.maytas, "signIn");
    await t.bridge.tick();
    expect(t.bridge.status().state).toBe("waiting");
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.bridge.status().state).toBe("paused");

    t.clock.advance(hour);
    await t.bridge.tick();
    expect(signIn).toHaveBeenCalledTimes(2);

    t.maytas.signInFails = false;
    t.bridge.resume();
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
  });

  test("a changed page layout pauses the bridge", async () => {
    const t = await withQueuedAdd();
    t.maytas.layoutChanged = true;
    await t.bridge.tick();
    expect(t.bridge.status().state).toBe("paused");
    expect(readSettings(t.db).bridgePausedReason).toContain("does not look as expected");
    expect(t.addWrites()).toBe(0);
  });

  test("an earlier save that has not settled defers the write without using an attempt", async () => {
    const t = await withQueuedAdd();
    let saving = true;
    const signIn = t.maytas.signIn.bind(t.maytas);
    spyOn(t.maytas, "signIn").mockImplementation(async (): Promise<MaytasSession> => ({ ...(await signIn()), saving: () => saving }));
    for (let i = 0; i < 4; i++) {
      await t.bridge.tick();
      t.clock.advance(hour);
    }
    expect(t.entry().sync).toMatchObject({ state: "queued", attempts: 0 });
    expect(t.addWrites()).toBe(0);
    saving = false;
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(t.addWrites()).toBe(1);
  });

  test("an outage is a wait, not a pause", async () => {
    const t = await withQueuedAdd();
    t.maytas.outage = true;
    await t.bridge.tick();
    expect(t.bridge.status().state).toBe("waiting");
    t.maytas.outage = false;
    t.clock.advance(hour);
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
  });

  test("with sync paused the bridge does not sign in at all", async () => {
    const t = await withQueuedAdd();
    t.entries.setSettings("app", { syncPaused: true });
    const signIn = spyOn(t.maytas, "signIn");
    await t.bridge.tick();
    expect(signIn).not.toHaveBeenCalled();
    expect(t.bridge.status().state).toBe("syncPaused");
  });

  test("a pause during the wait before sign-in stops the sign-in", async () => {
    const t = await withQueuedAdd();
    const signIn = spyOn(t.maytas, "signIn");
    const pass = t.bridge.tick();
    t.entries.setSettings("app", { syncPaused: true });
    await pass;
    expect(signIn).not.toHaveBeenCalled();
  });

  test("a pause while the grid loads stops the write", async () => {
    const t = await withQueuedAdd();
    duringNextGridRead(t, () => t.entries.setSettings("app", { syncPaused: true }));
    await t.bridge.tick();
    expect(t.addWrites()).toBe(0);
    expect(t.entry().sync.state).toBe("queued");
  });

  test("a pause during the wait before the write stops the write", async () => {
    const t = await withQueuedAdd();
    const sleep = t.clock.sleep;
    let gridRead = false;
    duringNextGridRead(t, () => (gridRead = true));
    spyOn(t.clock, "sleep").mockImplementation((ms, signal) => {
      if (gridRead) t.entries.setSettings("app", { syncPaused: true });
      return sleep(ms, signal);
    });
    await t.bridge.tick();
    expect(t.addWrites()).toBe(0);
    expect(t.entry().sync.state).toBe("queued");
  });

  test("the bridge does not sign in when there is no work", async () => {
    const t = await setup();
    const signIn = spyOn(t.maytas, "signIn");
    await t.bridge.tick();
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("reconcile", () => {
  test("the first run imports every row and the profile", async () => {
    const t = await setup();
    const imported = t.entries.list();
    expect(imported).toHaveLength(t.maytas.rows.length);
    expect(imported.every((e) => e.source === "maytas" && e.sync.state === "inMaytas")).toBe(true);
    const total = t.maytas.rows.reduce((sum, r) => sum + r.centihours, 0);
    expect(t.entries.progress()).toMatchObject({ confirmedCentihours: total, targetCentihours: 102_400 });
  });

  test("each run replaces the stored reviews with the list from Maytas", async () => {
    const t = await setup();
    expect(readReviews(t.db)).toEqual(sampleReviews);
    t.maytas.reviews = sampleReviews.slice(1);
    t.bridge.requestReconcile();
    await t.bridge.tick();
    expect(readReviews(t.db)).toEqual(sampleReviews.slice(1));
  });

  test("a failing reviews page keeps the last list and does not stop the OTJ sync", async () => {
    const t = await withQueuedAdd();
    const signIn = t.maytas.signIn.bind(t.maytas);
    spyOn(t.maytas, "signIn").mockImplementation(async (): Promise<MaytasSession> => ({
      ...(await signIn()),
      listReviews: async () => {
        throw new MaytasUnavailable("Maytas answered 500 for /etrack/LearnerSummary/Visits.");
      },
    }));
    t.bridge.requestReconcile();
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("inMaytas");
    expect(readReviews(t.db)).toEqual(sampleReviews);
  });

  test("rows that vanished or changed in Maytas need the user, and new rows are imported", async () => {
    const t = await setup();
    const [gone, changed] = t.maytas.rows;
    if (!gone || !changed) throw new Error("sample rows missing");
    t.maytas.rows = t.maytas.rows.filter((r) => r.rowId !== gone.rowId);
    changed.reflect = "Edited in Maytas";
    const added = t.maytas.insert({ ...changed, date: "2026-11-05", describe: "Typed straight into Maytas" });

    t.bridge.requestReconcile();
    await t.bridge.tick();

    const byRow = (rowId: string) => t.entries.list({ includeDeleted: true }).find((e) => e.maytasRowId === rowId);
    expect(byRow(gone.rowId)?.sync).toMatchObject({ state: "needsYou", reason: "The row vanished from Maytas." });
    expect(byRow(changed.rowId)?.sync).toMatchObject({ state: "needsYou", reason: "The row changed in Maytas." });
    expect(byRow(added.rowId)?.sync.state).toBe("inMaytas");
    expect(t.maytas.writes).toHaveLength(0);
  });

  test("a row that a pending delete owns is deleted, not imported", async () => {
    const t = await withUnconfirmedAdd();
    t.maytas.insert(t.content());
    t.entries.remove("app", t.id);
    t.bridge.requestReconcile();
    await t.bridge.tick();
    expect(t.entry().sync.state).toBe("removed");
    expect(t.rowsInMaytas()).toHaveLength(0);
    expect(t.entries.list({ q: "auth flow" })).toHaveLength(0);
  });

  test("the rows of an entry that needs the user are not imported, so the user can still pick one", async () => {
    const t = await withQueuedAdd();
    t.maytas.writeFaults.push("saveTwice");
    await t.bridge.tick();
    t.bridge.requestReconcile();
    await t.bridge.tick();
    expect(t.entries.list({ q: "auth flow" })).toHaveLength(1);
    const [row] = t.rowsInMaytas();
    expect(t.entries.resolve("app", t.id, { action: "useMaytas", rowId: row?.rowId ?? "" }).ok).toBe(true);
  });
});

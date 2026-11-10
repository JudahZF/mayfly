import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { entries as entriesTable } from "./db/schema";
import { sampleInput, setup } from "./testing";

const firstOk = <T extends { ok: boolean }>(outcomes: T[]) => {
  const [first] = outcomes;
  if (!first?.ok) throw new Error(`expected ok, got ${JSON.stringify(first)}`);
  return first as Extract<T, { ok: true }>;
};

describe("add", () => {
  test("a second add with the same date, hours and text returns the first entry", async () => {
    const t = await setup();
    const first = firstOk(t.entries.add("agent", [sampleInput()]));
    const again = firstOk(t.entries.add("agent", [sampleInput({ describe: "  Paired on the auth   flow with my mentor " })]));
    expect(again.value.created).toBe(false);
    expect(again.value.entry.id).toBe(first.value.entry.id);

    const batch = t.entries.add("app", [sampleInput({ date: "2026-11-08" }), sampleInput({ date: "2026-11-08" })]);
    expect(batch.map((o) => o.ok && o.value.created)).toEqual([true, false]);
    expect(t.entries.list({ q: "auth flow" })).toHaveLength(2);
  });

  test("an add with the same date, hours and text but other details is a conflict, not a silent merge", async () => {
    const t = await setup();
    firstOk(t.entries.add("app", [sampleInput()]));
    const [other] = t.entries.add("app", [sampleInput({ reflect: "Something else entirely" })]);
    expect(other).toMatchObject({ ok: false, error: "conflict" });
    expect(t.entries.list({ q: "auth flow" })).toHaveLength(1);
  });

  test("inputs that break the rules are refused per entry", async () => {
    const t = await setup();
    const outcomes = t.entries.add("app", [
      sampleInput({ date: "2026-11-11" }),
      sampleInput({ method: "Napping" }),
      sampleInput({ ksbs: ["Z9"] }),
      sampleInput({ hours: 1.234 }),
      sampleInput(),
    ]);
    expect(outcomes.map((o) => (o.ok ? "ok" : o.error))).toEqual(["invalid", "invalid", "invalid", "invalid", "ok"]);
  });

  test("an app entry is queued, and a meeting gets a warning", async () => {
    const t = await setup();
    const added = firstOk(t.entries.add("app", [sampleInput({ method: "Meetings" })]));
    expect(added.value.entry.sync.state).toBe("queued");
    expect(added.value.warnings.some((w) => w.startsWith("Meetings"))).toBe(true);
  });

  test("the same description again is a repeat, but two modules on one day are not", async () => {
    const t = await setup();
    const module = (describe: string, date = "2026-11-10") =>
      firstOk(t.entries.add("app", [sampleInput({ date, hours: 3, method: "Workplace Training", describe })])).value.warnings;
    expect(module("COMS601")).toEqual([]);
    expect(module("DAB601")).toEqual([]);
    expect(module(" coms601 ", "2026-11-03")).toEqual([expect.stringMatching(/^Looks like a repeat of entry .+ \(2026-11-10\)\.$/)]);
    expect(module("Paired on   the AUTH flow", "2026-11-02")).toEqual([]);
    expect(module("paired ON the auth  flow", "2026-11-01")).toEqual([expect.stringMatching(/\(2026-11-02\)\.$/)]);
  });
});

describe("agent in drafts mode", () => {
  const withEntries = async () => {
    const t = await setup();
    const draft = firstOk(t.entries.add("agent", [sampleInput()])).value.entry;
    const queued = firstOk(t.entries.add("app", [sampleInput({ date: "2026-11-02" })])).value.entry;
    const [synced] = t.entries.list({ state: "inMaytas" });
    if (!synced) throw new Error("no imported entry");
    return { ...t, draft, queued, synced };
  };

  test("adds become drafts, and drafts can be changed and deleted", async () => {
    const t = await withEntries();
    expect(t.draft.sync.state).toBe("draft");
    expect(t.entries.update("agent", t.draft.id, { hours: 1 }).ok).toBe(true);
    expect(t.entries.remove("agent", t.draft.id).ok).toBe(true);
  });

  test("every forbidden action is refused and names the mode", async () => {
    const t = await withEntries();
    const refusals = [
      t.entries.approve("agent", "all"),
      t.entries.update("agent", t.queued.id, { hours: 1 }),
      t.entries.update("agent", t.synced.id, { hours: 1 }),
      t.entries.remove("agent", t.queued.id),
      t.entries.remove("agent", t.synced.id),
      t.entries.setSettings("agent", { agentMode: "fullAccess" }),
      t.entries.setSettings("agent", { syncPaused: true }),
    ];
    for (const refusal of refusals) expect(refusal).toMatchObject({ ok: false, error: "notAllowed", mode: "drafts" });
    expect(t.entries.settings()).toEqual({ agentMode: "drafts", syncPaused: false });
  });

  test("in full access agent adds are queued and drafts can be approved, but settings stay closed", async () => {
    const t = await withEntries();
    t.entries.setSettings("app", { agentMode: "fullAccess" });
    expect(firstOk(t.entries.add("agent", [sampleInput({ date: "2026-11-03" })])).value.entry.sync.state).toBe("queued");
    const approved = t.entries.approve("agent", [t.draft.id]);
    expect(approved.ok && approved.value.map((e) => e.sync.state)).toEqual(["queued"]);
    expect(t.entries.update("agent", t.synced.id, { hours: 1 }).ok).toBe(true);
    expect(t.entries.setSettings("agent", { agentMode: "drafts" })).toMatchObject({ error: "notAllowed", mode: "fullAccess" });
  });
});

test("an entry that the bridge is checking cannot be changed", async () => {
  const t = await setup();
  const entry = firstOk(t.entries.add("app", [sampleInput()])).value.entry;
  t.db.update(entriesTable)
    .set({ sync: { state: "checking", op: "add", attempts: 0, replied: true, since: 0 } })
    .where(eq(entriesTable.id, entry.id))
    .run();
  expect(t.entries.update("app", entry.id, { hours: 1 })).toMatchObject({ ok: false, error: "busy" });
  expect(t.entries.remove("app", entry.id)).toMatchObject({ ok: false, error: "busy" });
});

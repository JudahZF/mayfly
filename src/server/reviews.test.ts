import { expect, test } from "bun:test";
import { reviewPrep, submitBy } from "./reviews";
import { sampleInput, setup } from "./testing";

test("the form is due five working days before the review, across the weekend", () => {
  expect(submitBy("2026-11-24")).toBe("2026-11-17");
  expect(submitBy("2026-11-20")).toBe("2026-11-13");
});

test("the prep counts only entries after the last completed review, without drafts or deleted entries, and keeps needs-you hours apart", async () => {
  const t = await setup();
  t.maytas.reviews = [
    { visitId: "V-2", type: "Progress Review", plannedDate: "2026-12-01", actualDate: null, outcome: null, staff: null, url: "https://maytas.example/2", form: null },
    { visitId: "V-1", type: "Progress Review", plannedDate: "2026-10-13", actualDate: "2026-10-13", outcome: "Completed", staff: null, url: "https://maytas.example/1", form: null },
  ];
  t.bridge.requestReconcile();
  await t.bridge.tick();
  t.maytas.rows = t.maytas.rows.filter((r) => r.date !== "2026-10-16");
  t.bridge.requestReconcile();
  await t.bridge.tick();

  t.entries.add("app", [sampleInput({ date: "2026-11-07" })]);
  t.entries.add("agent", [sampleInput({ date: "2026-11-09", describe: "A draft from the agent" })]);
  const [deleted] = t.entries.add("app", [sampleInput({ date: "2026-11-08", describe: "Deleted later" })]);
  if (!deleted?.ok) throw new Error("add failed");
  t.entries.remove("app", deleted.value.entry.id);

  const { next, last, since } = reviewPrep(t.db, t.entries, t.clock.now());
  expect(next?.visitId).toBe("V-2");
  expect(last?.visitId).toBe("V-1");
  expect(since.entries.map((e) => e.date)).toEqual(["2026-10-16", "2026-10-21", "2026-10-27", "2026-11-03", "2026-11-07"]);
  expect(since.confirmedCentihours).toBe(75 + 200 + 600);
  expect(since.needsYouCentihours).toBe(300);
  expect(since.pendingCentihours).toBe(250);
});

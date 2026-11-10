import { FakeMaytas, sampleRows } from "../maytas/fake";
import type { EntryFields } from "../shared/entry";
import { createMayfly } from "./api";
import { openDb } from "./db";
import type { Clock } from "./outbox";

/** A clock for tests: a sleep moves time forward on the next macrotask, unless it is aborted first. */
export function fakeClock(start = Date.parse("2026-11-10T12:00:00Z")) {
  let t = start;
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
        setImmediate(() => {
          if (signal?.aborted) return;
          t += ms;
          resolve();
        });
      }),
  } satisfies Clock & { advance(ms: number): void };
  return clock;
}

/** A Mayfly on an in-memory store and a fake Maytas with the sample rows, after the first reconcile. */
export async function setup({ rows = sampleRows, token }: { rows?: typeof sampleRows; token?: string } = {}) {
  const db = openDb(":memory:");
  const maytas = new FakeMaytas({ rows });
  const clock = fakeClock();
  const mayfly = createMayfly({ db, maytas, clock, token });
  await mayfly.bridge.tick();
  return { db, maytas, clock, ...mayfly };
}

export const sampleInput = (overrides: Partial<EntryFields> = {}): EntryFields => ({
  date: "2026-11-09",
  hours: 2.5,
  where: "Workplace",
  method: "Job Related Projects",
  describe: "Paired on the auth flow with my mentor",
  reflect: "How token refresh fails when the clock drifts",
  ksbs: ["S7"],
  ...overrides,
});

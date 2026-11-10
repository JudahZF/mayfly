import type { MaytasReview } from "../maytas/types";
import { type Db, readProfile, readReviews } from "./db";
import { type Entries, localDate } from "./entries";

const dayMs = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * dayMs).toISOString().slice(0, 10);
const isWorkingDay = (iso: string) => ![0, 6].includes(new Date(iso).getUTCDay());

/**
 * The last day to submit the Progress Review Form: five working days (Monday to Friday)
 * before the review. Mayfly does not know bank holidays, so it counts them as working days.
 */
export function submitBy(plannedDate: string) {
  let date = plannedDate;
  for (let counted = 0; counted < 5; ) {
    date = shift(date, -1);
    if (isWorkingDay(date)) counted++;
  }
  return date;
}

/** Working days after `from`, up to and including `to`. */
function workingDaysBetween(from: string, to: string) {
  let n = 0;
  for (let d = shift(from, 1); d <= to; d = shift(d, 1)) if (isWorkingDay(d)) n++;
  return n;
}

function upcoming(review: MaytasReview, today: string) {
  const deadline = submitBy(review.plannedDate);
  return {
    ...review,
    submitBy: deadline,
    daysLeft: Math.round((Date.parse(deadline) - Date.parse(today)) / dayMs),
    workingDaysLeft: workingDaysBetween(today, deadline),
    passed: deadline < today,
    formDone: /complete|submitted/i.test(review.form?.status ?? ""),
  };
}

/**
 * The facts for the next progress review, from the Maytas cache and Mayfly's own entries.
 * "Since" means entries dated after the last completed review. Drafts and deleted entries do not count.
 */
export function reviewPrep(db: Db, entries: Entries, now: number) {
  const today = localDate(now);
  const all = readReviews(db).filter((r) => /review/i.test(r.type));
  const [next] = all.filter((r) => r.actualDate === null && r.plannedDate >= today).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate));
  const [last] = all
    .flatMap((r) => (r.actualDate === null ? [] : [{ ...r, actualDate: r.actualDate }]))
    .sort((a, b) => b.actualDate.localeCompare(a.actualDate));
  const after = last?.actualDate ?? null;

  const since = entries
    .list()
    .filter((e) => e.sync.state !== "draft" && (after === null || e.date > after))
    .sort((a, b) => a.date.localeCompare(b.date));
  const total = (list: typeof since) => list.reduce((sum, e) => sum + e.centihours, 0);
  const confirmed = total(since.filter((e) => e.sync.state === "inMaytas"));
  const needsYou = total(since.filter((e) => e.sync.state === "needsYou"));

  const methods = new Map<string, { method: string; entries: number; centihours: number }>();
  for (const e of since) {
    const m = methods.get(e.method) ?? { method: e.method, entries: 0, centihours: 0 };
    m.entries++;
    m.centihours += e.centihours;
    methods.set(e.method, m);
  }
  const ksbs = (readProfile(db)?.ksbs ?? []).map(({ code, text }) => {
    const hits = since.filter((e) => e.ksbs.includes(code));
    return { code, text, entries: hits.length, centihours: total(hits) };
  });

  return {
    today,
    next: next ? upcoming(next, today) : null,
    last: last ?? null,
    since: {
      after,
      confirmedCentihours: confirmed,
      pendingCentihours: total(since) - confirmed - needsYou,
      needsYouCentihours: needsYou,
      entryCount: since.length,
      methods: [...methods.values()].sort((a, b) => b.centihours - a.centihours),
      ksbs: ksbs.filter((k) => k.entries > 0),
      ksbsWithoutEvidence: ksbs.filter((k) => k.entries === 0).map(({ code, text }) => ({ code, text })),
      entries: since.map((e) => ({
        id: e.id,
        date: e.date,
        centihours: e.centihours,
        method: e.method,
        describe: e.describe,
        reflect: e.reflect,
        ksbs: e.ksbs,
        state: e.sync.state,
      })),
    },
    progress: entries.progress(),
  };
}

export type ReviewPrep = ReturnType<typeof reviewPrep>;

const h = (centihours: number) => `${(centihours / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })} h`;
const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`)
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .replace(",", "");
const count = (n: number) => (n === 1 ? "1 entry" : `${n} entries`);
const sinceText = (iso: string | null) => (iso === null ? "the start" : `the last review (${day(iso)})`);

/** The prep as plain text: the reply of the MCP tool and the "Copy summary" text in the app. */
export function prepText({ next, last, since, progress }: ReviewPrep) {
  const lines: string[] = [];
  if (next) {
    lines.push(`Next review: ${day(next.plannedDate)}${next.staff ? ` with ${next.staff}` : ""} (${next.type}).`);
    const form = next.form ? `the ${next.form.name} form (status: ${next.form.status})` : "the review form (not queued in Maytas yet)";
    const left = next.passed ? "That date has passed." : `${next.workingDaysLeft === 1 ? "1 working day" : `${next.workingDaysLeft} working days`} left.`;
    lines.push(next.formDone ? `The ${next.form?.name ?? "review"} form is ${next.form?.status.toLowerCase()}.` : `Submit ${form} by ${day(next.submitBy)}. ${left}`);
  } else {
    lines.push("No review is planned in Maytas.");
  }
  lines.push(last ? `Last completed review: ${day(last.actualDate)}.` : "No completed review in Maytas.");
  lines.push(
    "",
    `Since ${sinceText(since.after)}: ${h(since.confirmedCentihours + since.pendingCentihours + since.needsYouCentihours)} in ${count(since.entryCount)} (${h(since.confirmedCentihours)} in Maytas, ${h(since.pendingCentihours)} on the way${since.needsYouCentihours > 0 ? `, ${h(since.needsYouCentihours)} that need you before they count` : ""}).`,
  );
  if (progress.targetCentihours !== null) {
    lines.push(`Overall: ${h(progress.confirmedCentihours)} of ${h(progress.targetCentihours)} in Maytas.`);
  }
  if (since.methods.length > 0) {
    lines.push("", "Hours per method:", ...since.methods.map((m) => `- ${m.method}: ${h(m.centihours)} (${count(m.entries)})`));
  }
  if (since.ksbs.length > 0) {
    lines.push("", "KSBs with evidence:", ...since.ksbs.map((k) => `- ${k.code}, ${h(k.centihours)}: ${k.text}`));
  }
  if (since.ksbsWithoutEvidence.length > 0) {
    lines.push("", "KSBs with no evidence:", ...since.ksbsWithoutEvidence.map((k) => `- ${k.code}: ${k.text}`));
  }
  if (since.entries.length > 0) {
    lines.push("", "Entries:");
    for (const e of since.entries) {
      lines.push(
        `- ${day(e.date)}, ${h(e.centihours)}, ${e.method}${e.ksbs.length > 0 ? `, ${e.ksbs.join(" ")}` : ""}${e.state === "inMaytas" ? "" : ` (${e.state === "needsYou" ? "needs you" : "not in Maytas yet"})`}`,
        `  What I did: ${e.describe}`,
        `  What I learned: ${e.reflect}`,
      );
    }
  }
  return lines.join("\n");
}

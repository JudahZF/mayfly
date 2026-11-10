import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import type { Refusal } from "../server/entries";
import { api } from "./api";

export type Entry = InferResponseType<typeof api.api.entries.$get, 200>["entries"][number];
export type AppState = InferResponseType<typeof api.api.state.$get, 200>;
export type Profile = NonNullable<AppState["profile"]>;
export type SyncState = Entry["sync"];
export type SyncStateName = SyncState["state"];
export type ReviewsData = InferResponseType<typeof api.api.reviews.$get, 200>;
export type Review = ReviewsData["reviews"][number];
export type NextReview = NonNullable<ReviewsData["prep"]["next"]>;

/** The API answered 401: the browser needs the access token. */
export class Unauthorized extends Error {}

/** The server refused the change. The message is written for the user. */
export class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusalText(refusal));
  }
}

const isRefusal = (body: unknown): body is Refusal =>
  typeof body === "object" && body !== null && "ok" in body && body.ok === false && "error" in body;

type Body<R> = R extends { json(): Promise<infer T> } ? T : never;
/** The body of a success: not a refusal, not a validator error. */
type Success<R> = Exclude<Body<R>, { ok: false } | { success: false }>;

/** Awaits an RPC call and returns its success body. Throws `Unauthorized`, `Refused` or `Error`. */
export async function unwrap<R extends { status: number; json(): Promise<unknown> }>(request: Promise<R>): Promise<Success<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    throw new Error("Mayfly is not answering. Check that it is running, then try again.");
  }
  if (res.status === 401) throw new Unauthorized("Mayfly needs the access token.");
  const body = await res.json().catch(() => null);
  if (isRefusal(body)) throw new Refused(body);
  if (body === null || res.status >= 400) throw new Error(`Mayfly could not do this (error ${res.status}). Try again.`);
  return body as Success<R>;
}

export const stateQuery = queryOptions({
  queryKey: ["state"],
  queryFn: () => unwrap(api.api.state.$get()),
  refetchInterval: (query) => refreshMs(query.state.data),
});

export type EntryFilter = {
  q?: string;
  from?: string;
  to?: string;
  state?: SyncStateName;
  includeDeleted?: boolean;
};

export const entriesQuery = ({ includeDeleted, ...filter }: EntryFilter = {}) =>
  queryOptions({
    queryKey: ["entries", { includeDeleted, ...filter }],
    queryFn: async () =>
      (await unwrap(api.api.entries.$get({ query: { ...filter, includeDeleted: includeDeleted ? "true" : undefined } }))).entries,
  });

export const entryQuery = (id: string) =>
  queryOptions({ queryKey: ["entry", id], queryFn: () => unwrap(api.api.entries[":id"].$get({ param: { id } })) });

export const ksbsQuery = queryOptions({
  queryKey: ["ksbs"],
  queryFn: async () => (await unwrap(api.api.ksbs.$get())).ksbs,
});

export const reviewsQuery = queryOptions({
  queryKey: ["reviews"],
  queryFn: () => unwrap(api.api.reviews.$get()),
});

/** The "submit by" line for the review form. It warns at 2 working days or less, and once the date has passed. */
export function formDeadline({ submitBy, passed, daysLeft, workingDaysLeft, formDone }: NextReview) {
  if (formDone) return { urgent: false, text: "The review form is done." };
  const when = formatDate(submitBy);
  if (passed) return { urgent: true, text: `The form was due ${when}.` };
  if (daysLeft === 0) return { urgent: true, text: `Submit the form today, ${when}.` };
  const left = workingDaysLeft === 1 ? "1 working day" : `${workingDaysLeft} working days`;
  return { urgent: workingDaysLeft <= 2, text: `Submit the form by ${when}. ${left} left.` };
}

/** True while the bridge has work that the user can watch move. */
export function isSending(state: AppState | undefined) {
  if (!state) return false;
  const { bridge } = state;
  if (bridge.state === "working") return true;
  if (bridge.state === "paused" || bridge.state === "syncPaused") return false;
  const c = bridge.counts;
  return (c.queued ?? 0) + (c.writing ?? 0) + (c.checking ?? 0) > 0;
}

const refreshMs = (state: AppState | undefined) => (isSending(state) ? 2_000 : 20_000);

/** The poll interval for entry queries: fast while entries move, slow otherwise. */
export function useRefreshMs() {
  return refreshMs(useQuery(stateQuery).data);
}

/** Marks every query that an entry change can touch as stale. */
export const refreshEntries = (qc: QueryClient) =>
  Promise.all(["state", "entries", "entry", "ksbs", "log", "reviews"].map((key) => qc.invalidateQueries({ queryKey: [key] })));

const fieldNames: Record<string, string> = {
  date: "Date",
  startTime: "Start time",
  hours: "Hours",
  where: "Where",
  method: "Method",
  describe: "What you did",
  reflect: "What you learned",
  anythingElse: "Anything else",
  ksbs: "KSBs",
};

/** Turns a server issue such as `method: must be one of …` into a sentence. */
export function issueText(issue: string) {
  const match = issue.match(/^(\w+)(?:\.\d+)?: (.*)$/);
  const text = match ? `${fieldNames[match[1] ?? ""] ?? match[1]}: ${match[2]}` : issue;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function refusalText(r: Refusal) {
  switch (r.error) {
    case "busy":
      return r.message.startsWith("The delete")
        ? "The delete is still on its way to Maytas. Try again when it is done."
        : "Mayfly is sending this entry to Maytas right now. Try again in a minute.";
    case "conflict":
      if (r.message.includes("already has this date")) return "Another entry has the same date, hours and description. Change one of them first.";
      if (r.message.includes("but other details")) return "You already have an entry with this date, hours and description, but its other details differ. Change that entry, or change the description.";
      if (r.message.includes("needs attention. Resolve")) return "This entry needs you first. Resolve it on the Needs you page.";
      if (r.message.includes("does not need attention")) return "This entry does not need you any more.";
      if (r.message.includes("is linked to entry")) return "That Maytas row belongs to another entry.";
      return r.message;
    case "invalid":
      return r.issues.map(issueText).join(" ");
    case "notFound":
      return "Mayfly cannot find this entry. It may be deleted.";
    case "notAllowed":
      return r.message;
  }
}

/** A server warning in plain words, with the date of the entry it repeats. */
export function warningText(warning: string) {
  const repeat = warning.match(/^Looks like a repeat of entry (\S+) \((\d{4}-\d{2}-\d{2})\)\.$/);
  return repeat ? { text: `This looks like a repeat of your entry on ${formatDate(repeat[2] ?? "")}.`, entryId: repeat[1] } : { text: warning };
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Try again.");

// Dates and numbers

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayIso = () => isoDate(new Date());

export function shiftDate(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Monday of the week that holds `iso`. */
export function weekStart(iso: string) {
  const day = new Date(`${iso}T12:00:00`).getDay();
  return shiftDate(iso, -((day + 6) % 7));
}

export function formatDate(iso: string, { weekday = true } = {}) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: weekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export const formatTime = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function formatMoment(ms: number) {
  const iso = isoDate(new Date(ms));
  const day = iso === todayIso() ? "today" : iso === shiftDate(todayIso(), -1) ? "yesterday" : formatDate(iso, { weekday: false });
  return `${day} at ${formatTime(ms)}`;
}

export const formatHours = (centihours: number) => (centihours / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 });

export const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? "";

// Sync states

export type Tone = "draft" | "queued" | "sending" | "done" | "problem" | "removed";

const opWords = { add: "", edit: "Change ", delete: "Delete " } as const;

/** The name, colour and one-line explanation of a sync state, used on every screen. */
export function describeSync(sync: SyncState): { tone: Tone; label: string; detail: string } {
  switch (sync.state) {
    case "draft":
      return { tone: "draft", label: "Draft", detail: "From an agent. It waits for your approval." };
    case "queued":
      return {
        tone: "queued",
        label: sync.op === "add" ? "Queued" : `${opWords[sync.op]}queued`,
        detail:
          sync.attempts > 0 && sync.notBefore > Date.now()
            ? `Maytas did not confirm it yet. Mayfly tries again ${formatMoment(sync.notBefore)}.`
            : "Waiting for its turn to go to Maytas.",
      };
    case "writing":
      return { tone: "sending", label: "Sending", detail: "Mayfly is sending this to Maytas now." };
    case "checking":
      return { tone: "sending", label: "Sending", detail: "Sent. Mayfly is reading Maytas back to check it arrived once." };
    case "inMaytas":
      return { tone: "done", label: "In Maytas", detail: `Confirmed in Maytas ${formatMoment(sync.confirmedAt)}.` };
    case "removed":
      return { tone: "removed", label: "Deleted", detail: `Deleted ${formatMoment(sync.at)}. Not in Maytas.` };
    case "needsYou":
      return { tone: "problem", label: "Needs you", detail: sync.reason };
  }
}

export const syncFilterOptions: { value: SyncStateName; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "queued", label: "Queued" },
  { value: "inMaytas", label: "In Maytas" },
  { value: "needsYou", label: "Needs you" },
  { value: "removed", label: "Deleted" },
];

export const sourceText = { app: "You added it in Mayfly", agent: "An agent added it", maytas: "Imported from Maytas" } as const;

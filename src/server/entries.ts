import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  type AgentMode,
  contentOf,
  type EntryContent,
  type EntryFields,
  type EntryPatchFields,
  entryInput,
  entryPatch,
  fingerprint,
  normaliseText,
  type ResolveInput,
  sameContent,
  type SyncOp,
  type SyncState,
  type SyncStateName,
} from "../shared/entry";
import type { MaytasProfile } from "../maytas/types";
import { type Db, readProfile, readSettings, writeLog, writeSettings } from "./db";
import { type Entry, entries } from "./db/schema";

export type Actor = "app" | "agent";

export type Refusal =
  | { ok: false; error: "notAllowed"; mode: AgentMode; message: string }
  | { ok: false; error: "busy"; message: string }
  | { ok: false; error: "notFound"; message: string }
  | { ok: false; error: "invalid"; message: string; issues: string[] }
  | { ok: false; error: "conflict"; message: string };

export type Result<T> = { ok: true; value: T } | Refusal;

export type AddOutcome = Result<{ entry: Entry; created: boolean; warnings: string[] }>;

export type EntryFilter = {
  q?: string;
  from?: string;
  to?: string;
  state?: SyncStateName;
  includeDeleted?: boolean;
};

export type SettingsPatch = { agentMode?: AgentMode; syncPaused?: boolean };

const ok = <T>(value: T) => ({ ok: true, value }) as const;
const refuse = <E extends Refusal["error"]>(error: E, message: string) => ({ ok: false, error, message }) as const;
const invalid = (issues: string[]) => ({ ok: false, error: "invalid", message: issues.join("; "), issues }) as const;

/** Methods that often fail the funding rules. */
const riskyMethods = new Map([
  ["Meetings", "Meetings often fail the off-the-job rules. Say what you learnt, not only that you attended."],
  ["Assessment", "Assessment time often does not count as off-the-job training. Check with your coach."],
]);

export const isBusy = (sync: SyncState) => sync.state === "writing" || sync.state === "checking";

export const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function ruleIssues(content: EntryContent, profile: MaytasProfile | null, today: string) {
  if (!profile) return ["The Maytas profile is not loaded yet. Run a sync first."];
  const issues: string[] = [];
  const parsed = new Date(`${content.date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== content.date) {
    issues.push(`date: ${content.date} is not a valid date`);
  } else if (content.date > today) {
    issues.push(`date: ${content.date} is in the future`);
  }
  if (!profile.methods.includes(content.method)) {
    issues.push(`method: must be one of ${profile.methods.join(", ")}`);
  }
  if (!profile.wheres.includes(content.where)) {
    issues.push(`where: must be one of ${profile.wheres.join(", ")}`);
  }
  const codes = new Set(profile.ksbs.map((k) => k.code));
  const unknown = content.ksbs.filter((k) => !codes.has(k));
  if (unknown.length > 0) issues.push(`ksbs: unknown codes ${unknown.join(", ")}`);
  return issues;
}

const zodIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((i) => (i.path.length > 0 ? `${i.path.map(String).join(".")}: ${i.message}` : i.message));

/** The only module that changes entries. The API and the MCP server both call it. */
export function createEntries({ db, now = Date.now, onQueued = () => {} }: { db: Db; now?: () => number; onQueued?: () => void }) {
  const log = (actor: Actor, kind: string, entryId: string | null, detail: string) =>
    writeLog(db, { at: now(), kind, entryId, source: actor, detail });

  /** The agent-mode rules, in one place. Actor `app` can do everything. */
  function permit(actor: Actor, action: "add" | "changeDraft" | "approve" | "changeSynced" | "resolve" | "settings") {
    if (actor === "app") return null;
    const mode = readSettings(db).agentMode;
    const refusal = (message: string) => ({ ok: false, error: "notAllowed", mode, message }) as const;
    if (action === "settings") return refusal("Agents cannot change settings or the agent mode.");
    if (action === "add" || action === "changeDraft" || mode === "fullAccess") return null;
    const messages = {
      approve: "Only the user can approve drafts while the agent mode is drafts.",
      changeSynced: "In drafts mode an agent can change or delete only drafts. This entry is queued or in Maytas.",
      resolve: "In drafts mode only the user can resolve an entry that needs attention.",
    } as const;
    return refusal(messages[action]);
  }

  const find = (id: string) => db.select().from(entries).where(eq(entries.id, id)).get();

  const liveByFingerprint = (fp: string) =>
    db
      .select()
      .from(entries)
      .where(and(eq(entries.fingerprint, fp), isNull(entries.deletedAt)))
      .get();

  const save = (id: string, patch: Partial<Omit<Entry, "id">>) =>
    db
      .update(entries)
      .set({ ...patch, updatedAt: now() })
      .where(eq(entries.id, id))
      .returning()
      .get();

  function settings() {
    const { agentMode, syncPaused } = readSettings(db);
    return { agentMode, syncPaused };
  }

  const queued = (op: SyncOp): SyncState => ({ state: "queued", op, attempts: 0, notBefore: 0 });

  function warningsFor(content: EntryContent, selfId: string) {
    const warnings: string[] = [];
    // A repeat is the same activity again: the same description. Two modules on one day are not repeats.
    const same = (text: string) => normaliseText(text).toLowerCase();
    const repeat = db
      .select({ id: entries.id, date: entries.date, describe: entries.describe })
      .from(entries)
      .where(and(isNull(entries.deletedAt), sql`${entries.id} != ${selfId}`))
      .all()
      .find((e) => same(e.describe) === same(content.describe));
    if (repeat) warnings.push(`Looks like a repeat of entry ${repeat.id} (${repeat.date}).`);
    const risky = riskyMethods.get(content.method);
    if (risky) warnings.push(risky);
    return warnings;
  }

  function addOne(actor: Actor, raw: EntryFields, asDraft: boolean): AddOutcome {
    const parsed = entryInput.safeParse(raw);
    if (!parsed.success) return invalid(zodIssues(parsed.error.issues));
    const { startTime, ...rest } = parsed.data;
    const content: EntryContent = { ...rest, anythingElse: rest.anythingElse ?? null };
    const issues = ruleIssues(content, readProfile(db), localDate(now()));
    if (issues.length > 0) return invalid(issues);

    const fp = fingerprint(content);
    const existing = liveByFingerprint(fp);
    if (existing) {
      return sameContent(existing, content)
        ? ok({ entry: existing, created: false, warnings: [] })
        : refuse("conflict", `Entry ${existing.id} has this date, hours and text, but other details. Change that entry, or change the text.`);
    }

    const id = crypto.randomUUID();
    const warnings = warningsFor(content, id);
    const at = now();
    const entry = db
      .insert(entries)
      .values({
        id,
        ...content,
        startTime: startTime ?? null,
        source: actor,
        fingerprint: fp,
        sync: asDraft ? { state: "draft" } : queued("add"),
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    log(actor, asDraft ? "entry.draft" : "entry.add", id, `${content.date} ${content.centihours / 100} h ${content.describe}`);
    return ok({ entry, created: true, warnings });
  }

  /** Finds an entry that the actor may change, or the reason it may not. */
  function changeable(actor: Actor, id: string): Result<Entry> {
    const entry = find(id);
    if (!entry || entry.deletedAt !== null) return refuse("notFound", `No entry ${id}`);
    if (isBusy(entry.sync)) return refuse("busy", "The bridge is writing or checking this entry. Try again in a minute.");
    if (entry.sync.state === "needsYou") return refuse("conflict", "This entry needs attention. Resolve it first.");
    const denied = permit(actor, entry.sync.state === "draft" ? "changeDraft" : "changeSynced");
    return denied ?? ok(entry);
  }

  return {
    list(filter: EntryFilter = {}) {
      const conditions: (SQL | undefined)[] = [
        filter.includeDeleted ? undefined : isNull(entries.deletedAt),
        filter.from ? gte(entries.date, filter.from) : undefined,
        filter.to ? lte(entries.date, filter.to) : undefined,
        filter.state ? sql`json_extract(${entries.sync}, '$.state') = ${filter.state}` : undefined,
      ];
      if (filter.q) {
        const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(
          or(
            sql`${entries.describe} like ${pattern} escape '\\'`,
            sql`${entries.reflect} like ${pattern} escape '\\'`,
            sql`${entries.anythingElse} like ${pattern} escape '\\'`,
          ),
        );
      }
      return db
        .select()
        .from(entries)
        .where(and(...conditions))
        .orderBy(desc(entries.date), asc(entries.createdAt))
        .all();
    },

    get(id: string): Result<Entry> {
      const entry = find(id);
      return entry ? ok(entry) : refuse("notFound", `No entry ${id}`);
    },

    /** Idempotent: an input with the content of a live entry returns that entry. */
    add(actor: Actor, inputs: EntryFields[]): AddOutcome[] {
      const denied = permit(actor, "add");
      if (denied) return inputs.map(() => denied);
      const asDraft = actor === "agent" && readSettings(db).agentMode === "drafts";
      const outcomes = db.transaction(() => inputs.map((raw) => addOne(actor, raw, asDraft)));
      if (!asDraft && outcomes.some((o) => o.ok && o.value.created)) onQueued();
      return outcomes;
    },

    update(actor: Actor, id: string, raw: EntryPatchFields): Result<Entry> {
      const found = changeable(actor, id);
      if (!found.ok) return found;
      const entry = found.value;
      const parsed = entryPatch.safeParse(raw);
      if (!parsed.success) return invalid(zodIssues(parsed.error.issues));
      const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
      const merged = { ...entry, ...patch };
      const content = contentOf(merged);
      const issues = ruleIssues(content, readProfile(db), localDate(now()));
      if (issues.length > 0) return invalid(issues);

      const fp = fingerprint(content);
      const clash = liveByFingerprint(fp);
      if (clash && clash.id !== id) return refuse("conflict", `Entry ${clash.id} already has this date, hours and text.`);

      const sync = entry.sync.state === "inMaytas" ? queued("edit") : entry.sync;
      const updated = save(id, { ...content, startTime: merged.startTime ?? null, fingerprint: fp, sync });
      log(actor, "entry.update", id, sync.state === "queued" ? `queued ${sync.op}` : sync.state);
      if (sync.state === "queued") onQueued();
      return ok(updated);
    },

    /** Marks an entry deleted. It stays in the store; a row in Maytas is deleted through the outbox. */
    remove(actor: Actor, id: string): Result<Entry> {
      const found = changeable(actor, id);
      if (!found.ok) return found;
      const { sync, maytasRowId } = found.value;
      const mayBeInMaytas = maytasRowId !== null || (sync.state === "queued" && sync.attempts > 0);
      const at = now();
      const next: SyncState = mayBeInMaytas ? queued("delete") : { state: "removed", at };
      const updated = save(id, { deletedAt: at, sync: next });
      log(actor, "entry.delete", id, mayBeInMaytas ? "queued delete" : "removed locally");
      if (mayBeInMaytas) onQueued();
      return ok(updated);
    },

    /** Sends a deleted entry to Maytas again, as a new add. */
    restore(actor: Actor, id: string): Result<Entry> {
      const entry = find(id);
      if (!entry || entry.deletedAt === null) return refuse("notFound", `No deleted entry ${id}`);
      if (entry.sync.state !== "removed") return refuse("busy", "The delete is still on its way to Maytas.");
      const denied = permit(actor, "add");
      if (denied) return denied;
      const clash = liveByFingerprint(entry.fingerprint);
      if (clash) return refuse("conflict", `Entry ${clash.id} already has this date, hours and text.`);
      const asDraft = actor === "agent" && readSettings(db).agentMode === "drafts";
      const updated = save(id, { deletedAt: null, maytasRowId: null, sync: asDraft ? { state: "draft" } : queued("add") });
      log(actor, "entry.restore", id, asDraft ? "draft" : "queued add");
      if (!asDraft) onQueued();
      return ok(updated);
    },

    approve(actor: Actor, ids: string[] | "all"): Result<Entry[]> {
      const denied = permit(actor, "approve");
      if (denied) return denied;
      const drafts = db
        .select()
        .from(entries)
        .where(and(isNull(entries.deletedAt), sql`json_extract(${entries.sync}, '$.state') = 'draft'`))
        .all()
        .filter((e) => ids === "all" || ids.includes(e.id));
      const approved = db.transaction(() => drafts.map((e) => save(e.id, { sync: queued("add") })));
      for (const e of approved) log(actor, "entry.approve", e.id, "queued add");
      if (approved.length > 0) onQueued();
      return ok(approved);
    },

    /**
     * Settles an entry in `needsYou`.
     * - retry: run the same operation again from the look step.
     * - useMaytas: link to that Maytas row and take its content.
     * - useMine: link to that Maytas row and send the Mayfly content to it.
     * - forget: delete the entry in Mayfly only. Nothing is sent to Maytas.
     */
    resolve(actor: Actor, id: string, input: ResolveInput): Result<Entry> {
      const entry = find(id);
      if (!entry) return refuse("notFound", `No entry ${id}`);
      if (entry.sync.state !== "needsYou") return refuse("conflict", "This entry does not need attention.");
      const denied = permit(actor, "resolve");
      if (denied) return denied;
      const { op, rows } = entry.sync;
      const at = now();

      let patch: Partial<Entry>;
      if (input.action === "retry") {
        patch = { sync: queued(op), ...(op === "add" ? { maytasRowId: null } : {}) };
      } else if (input.action === "forget") {
        patch = { sync: { state: "removed", at }, deletedAt: entry.deletedAt ?? at, maytasRowId: null };
      } else {
        const row = rows.find((r) => r.rowId === input.rowId);
        if (!row) return invalid([`rowId: ${input.rowId} is not one of the rows on this entry`]);
        const owner = db.select().from(entries).where(eq(entries.maytasRowId, row.rowId)).get();
        if (owner && owner.id !== id) return refuse("conflict", `Row ${row.rowId} is linked to entry ${owner.id}.`);
        if (input.action === "useMine") {
          patch = { maytasRowId: row.rowId, deletedAt: null, sync: queued("edit") };
        } else {
          const { rowId, ...content } = row;
          const fp = fingerprint(content);
          const clash = liveByFingerprint(fp);
          if (clash && clash.id !== id) return refuse("conflict", `Entry ${clash.id} already has this date, hours and text.`);
          patch = { ...content, fingerprint: fp, maytasRowId: rowId, deletedAt: null, sync: { state: "inMaytas", confirmedAt: at } };
        }
      }
      const updated = save(id, patch);
      log(actor, "entry.resolve", id, input.action);
      if (updated.sync.state === "queued") onQueued();
      return ok(updated);
    },

    progress() {
      const profile = readProfile(db);
      const totals = { confirmed: 0, pending: 0, drafts: 0, needsYou: 0 };
      for (const { centihours, sync } of db
        .select({ centihours: entries.centihours, sync: entries.sync })
        .from(entries)
        .where(isNull(entries.deletedAt))
        .all()) {
        if (sync.state === "inMaytas") totals.confirmed += centihours;
        else if (sync.state === "draft") totals.drafts += centihours;
        else if (sync.state === "needsYou") totals.needsYou += centihours;
        else totals.pending += centihours;
      }
      const target = profile?.targetCentihours ?? null;
      const today = localDate(now());
      const daysLeft = profile?.endDate ? (Date.parse(profile.endDate) - Date.parse(today)) / 86_400_000 : null;
      const remaining = target === null ? null : Math.max(0, target - totals.confirmed - totals.pending);
      const pacePerWeek =
        remaining === null || daysLeft === null ? null : daysLeft <= 0 ? remaining : Math.ceil(remaining / (daysLeft / 7));
      return {
        confirmedCentihours: totals.confirmed,
        pendingCentihours: totals.pending,
        draftCentihours: totals.drafts,
        needsYouCentihours: totals.needsYou,
        targetCentihours: target,
        remainingCentihours: remaining,
        pacePerWeekCentihours: pacePerWeek,
        endDate: profile?.endDate ?? null,
        standard: profile?.standard ?? null,
      };
    },

    /** Hours of evidence per KSB of the standard. Drafts do not count. */
    ksbCoverage() {
      const profile = readProfile(db);
      if (!profile) return [];
      const live = db
        .select({ ksbs: entries.ksbs, centihours: entries.centihours, sync: entries.sync })
        .from(entries)
        .where(isNull(entries.deletedAt))
        .all()
        .filter((e) => e.sync.state !== "draft");
      return profile.ksbs.map(({ code, text }) => {
        const hits = live.filter((e) => e.ksbs.includes(code));
        return { code, text, entries: hits.length, centihours: hits.reduce((sum, e) => sum + e.centihours, 0) };
      });
    },

    settings,

    setSettings(actor: Actor, patch: SettingsPatch): Result<ReturnType<typeof settings>> {
      const denied = permit(actor, "settings");
      if (denied) return denied;
      writeSettings(db, patch);
      log(actor, "settings", null, JSON.stringify(patch));
      if (patch.syncPaused === false) onQueued();
      return ok(settings());
    },
  };
}

export type Entries = ReturnType<typeof createEntries>;

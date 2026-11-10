import { z } from "zod";

/** What Maytas stores for one OTJ row. Hours are centihours: 2.25 h is 225. */
export type EntryContent = {
  date: string;
  centihours: number;
  where: string;
  method: string;
  describe: string;
  reflect: string;
  anythingElse: string | null;
  ksbs: string[];
};

const requiredText = z.string().trim().min(1, "Required");

const hours = z
  .number()
  .positive("Hours must be above 0")
  .max(24, "Hours must be at most 24")
  .refine((h) => Math.abs(h * 100 - Math.round(h * 100)) < 1e-6, "Hours can have at most 2 decimals");

/** Fields of the form. Method, where and KSB codes are checked against the profile by the server. */
export const entryFields = z.object({
  date: z.iso.date(),
  startTime: z.iso.time({ precision: -1 }).nullish(),
  hours,
  where: requiredText,
  method: requiredText,
  describe: requiredText,
  reflect: requiredText,
  anythingElse: z
    .string()
    .trim()
    .nullish()
    .transform((text) => (text === "" ? null : text)),
  ksbs: z.array(z.string().trim().min(1)).optional(),
});

export const entryInput = entryFields.transform(({ hours, ksbs, ...rest }) => ({
  ...rest,
  centihours: Math.round(hours * 100),
  ksbs: ksbs ?? [],
}));

export const entryPatch = entryFields.partial().transform(({ hours, ...rest }) => ({
  ...rest,
  centihours: hours === undefined ? undefined : Math.round(hours * 100),
}));

export type EntryFields = z.input<typeof entryFields>;
export type EntryPatchFields = z.input<typeof entryPatch>;
export type EntryInput = z.output<typeof entryInput>;
export type EntryPatch = z.output<typeof entryPatch>;

/** Picks the fields that Maytas stores. */
export const contentOf = (e: EntryContent): EntryContent => ({
  date: e.date,
  centihours: e.centihours,
  where: e.where,
  method: e.method,
  describe: e.describe,
  reflect: e.reflect,
  anythingElse: e.anythingElse,
  ksbs: e.ksbs,
});

export const normaliseText = (text: string) => text.trim().replace(/\s+/g, " ");

export const fingerprint = (entry: Pick<EntryContent, "date" | "centihours" | "describe">) =>
  `${entry.date}|${entry.centihours}|${normaliseText(entry.describe)}`;

export const sameContent = (a: EntryContent, b: EntryContent) =>
  a.date === b.date &&
  a.centihours === b.centihours &&
  a.where === b.where &&
  a.method === b.method &&
  normaliseText(a.describe) === normaliseText(b.describe) &&
  normaliseText(a.reflect) === normaliseText(b.reflect) &&
  normaliseText(a.anythingElse ?? "") === normaliseText(b.anythingElse ?? "") &&
  [...a.ksbs].sort().join() === [...b.ksbs].sort().join();

export const syncOps = ["add", "edit", "delete"] as const;
export type SyncOp = (typeof syncOps)[number];

/**
 * Where an entry is on its way to Maytas. Only a read of the Maytas grid moves an
 * entry to `inMaytas` or `removed`. `removed` entries stay in the store (deleted).
 * `checking.replied` is false when the write got no reply: that request can still arrive.
 */
export type SyncState =
  | { state: "draft" }
  | { state: "queued"; op: SyncOp; attempts: number; notBefore: number }
  | { state: "writing"; op: SyncOp; attempts: number; startedAt: number }
  | { state: "checking"; op: SyncOp; attempts: number; since: number; replied: boolean }
  | { state: "inMaytas"; confirmedAt: number }
  | { state: "removed"; at: number }
  | { state: "needsYou"; op: SyncOp; reason: string; rows: MaytasRow[] };

export type SyncStateName = SyncState["state"];
export const syncStateNames = [
  "draft",
  "queued",
  "writing",
  "checking",
  "inMaytas",
  "removed",
  "needsYou",
] as const satisfies readonly SyncStateName[];

/** One row of the Maytas OTJ grid. `rowId` is the ID that Maytas uses for Edit and Delete. */
export type MaytasRow = EntryContent & { rowId: string };

export const agentModes = ["drafts", "fullAccess"] as const;
export type AgentMode = (typeof agentModes)[number];

export const resolveInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("useMaytas"), rowId: z.string().min(1) }),
  z.object({ action: z.literal("useMine"), rowId: z.string().min(1) }),
  z.object({ action: z.literal("forget") }),
]);
export type ResolveInput = z.output<typeof resolveInput>;

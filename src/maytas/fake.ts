import type { EntryContent } from "../shared/entry";
import {
  LayoutChanged,
  type Maytas,
  type MaytasProfile,
  type MaytasReview,
  type MaytasRow,
  type MaytasSession,
  MaytasUnavailable,
  SignInFailed,
} from "./types";

/**
 * What the next write call does. One fault is used up per write.
 * - `hang`: never replies, row not saved.
 * - `hangAfterSave`: never replies, row saved.
 * - `dropReply`: row saved, then the call fails.
 * - `saveTwice`: row saved two times.
 * - `notSaved`: replies normally, row not saved.
 * - `sessionEnds`: the session ends during the call, row not saved.
 * - `alterText`: row saved, but Maytas changes the describe text.
 */
export type WriteFault = "hang" | "hangAfterSave" | "dropReply" | "saveTwice" | "notSaved" | "sessionEnds" | "alterText";

export type WriteCall =
  | { kind: "add"; row: EntryContent }
  | { kind: "edit"; rowId: string; row: EntryContent }
  | { kind: "delete"; rowId: string };

const never = () => new Promise<never>(() => {});

/** An in-memory Maytas for tests and `MAYTAS_MODE=fake`, with fault injection. */
export class FakeMaytas implements Maytas {
  rows: MaytasRow[];
  profile: MaytasProfile;
  reviews: MaytasReview[] = sampleReviews;
  /** Every write request that reached the fake, in order. */
  writes: WriteCall[] = [];
  writeFaults: WriteFault[] = [];
  signIns = 0;
  signInFails = false;
  outage = false;
  layoutChanged = false;
  private nextRowId: number;
  private sessionCounter = 0;
  private currentSession = 0;

  get signedIn() {
    return this.currentSession !== 0;
  }

  private onChange: ((rows: MaytasRow[]) => void) | undefined;

  /**
   * `rows` get new row IDs. `saved` rows keep theirs (a fake restored from disk).
   * `onChange` runs after every change to the rows.
   */
  constructor(
    seed: { rows?: EntryContent[]; saved?: MaytasRow[]; profile?: MaytasProfile; onChange?: (rows: MaytasRow[]) => void } = {},
  ) {
    this.profile = seed.profile ?? sampleProfile;
    this.rows = structuredClone(seed.saved ?? []);
    this.nextRowId = Math.max(1000, ...this.rows.map((r) => Number(r.rowId.replace(/\D/g, "")) || 0)) + 1;
    for (const row of seed.rows ?? []) this.insert(row);
    this.onChange = seed.onChange;
  }

  /** Adds a row as if the user typed it in Maytas. */
  insert(row: EntryContent) {
    const saved = { ...row, ksbs: [...row.ksbs], rowId: `otj-${this.nextRowId++}` };
    this.rows.push(saved);
    this.onChange?.(this.rows);
    return saved;
  }

  async signIn(): Promise<MaytasSession> {
    if (this.outage) throw new MaytasUnavailable("Maytas is down");
    if (this.layoutChanged) throw new LayoutChanged("The Maytas sign-in page does not look as expected");
    if (this.signInFails) throw new SignInFailed("Wrong username or password");
    this.signIns++;
    const id = ++this.sessionCounter;
    this.currentSession = id;

    const guard = () => {
      if (this.currentSession !== id) throw new MaytasUnavailable("The session ended");
      if (this.outage) throw new MaytasUnavailable("Maytas is down");
      if (this.layoutChanged) throw new LayoutChanged("The Maytas OTJ grid does not look as expected");
    };
    const endSession = () => {
      this.currentSession = 0;
    };
    const write = async (call: WriteCall, save: () => void, saveAltered: () => void) => {
      guard();
      this.writes.push(call);
      const fault = this.writeFaults.shift();
      switch (fault) {
        case "hang":
          return never();
        case "hangAfterSave":
          save();
          return never();
        case "dropReply":
          save();
          throw new MaytasUnavailable("The connection was reset");
        case "saveTwice":
          save();
          save();
          return;
        case "notSaved":
          return;
        case "sessionEnds":
          endSession();
          throw new MaytasUnavailable("The session ended");
        case "alterText":
          saveAltered();
          return;
        case undefined:
          save();
      }
    };
    const alter = (row: EntryContent) => ({ ...row, describe: `${row.describe.trim()}.` });

    return {
      getProfile: async () => {
        guard();
        return structuredClone(this.profile);
      },
      listOtj: async () => {
        guard();
        return structuredClone(this.rows);
      },
      listReviews: async () => {
        guard();
        return structuredClone(this.reviews);
      },
      addOtj: (row) =>
        write(
          { kind: "add", row },
          () => this.insert(row),
          () => this.insert(alter(row)),
        ),
      editOtj: (rowId, row) => {
        const replace = (content: EntryContent) => {
          const index = this.rows.findIndex((r) => r.rowId === rowId);
          if (index >= 0) this.rows[index] = { ...content, ksbs: [...content.ksbs], rowId };
          this.onChange?.(this.rows);
        };
        return write(
          { kind: "edit", rowId, row },
          () => replace(row),
          () => replace(alter(row)),
        );
      },
      deleteOtj: (rowId) => {
        const remove = () => {
          this.rows = this.rows.filter((r) => r.rowId !== rowId);
          this.onChange?.(this.rows);
        };
        return write({ kind: "delete", rowId }, remove, remove);
      },
      signOut: async () => {
        if (this.currentSession === id) endSession();
      },
    };
  }
}

export const sampleProfile: MaytasProfile = {
  targetCentihours: 102_400,
  standard: "DTSP Software Engineer",
  endDate: "2028-09-30",
  ksbs: [
    { code: "K1", text: "How teams work effectively to produce software and how to contribute appropriately" },
    { code: "K5", text: "Principles and uses of relational and non-relational databases" },
    { code: "K8", text: "Software design approaches and patterns, to identify reusable solutions" },
    { code: "K11", text: "How to test software, including unit, integration and user acceptance testing" },
    { code: "S2", text: "Develop effective user interfaces" },
    { code: "S7", text: "Apply structured techniques to problem solving, debug code and understand the structure of programs" },
    { code: "S11", text: "Apply an appropriate software development approach according to the relevant paradigm" },
    { code: "S14", text: "Follow company, team or client approaches to continuous integration, version and source control" },
    { code: "B1", text: "Works independently and takes responsibility" },
    { code: "B4", text: "Works collaboratively with a wide range of people in different roles" },
    { code: "B7", text: "Committed to continued professional development" },
  ],
  methods: [
    "Job Related Projects",
    "Meetings",
    "Research",
    "Mentoring",
    "Performing New Elements of The Job",
    "Workplace Training",
    "Self-directed study",
    "Assessment",
    "Online Training",
    "Conferences",
  ],
  wheres: ["University", "Workplace", "Other"],
};

const review = (visitId: string, plannedDate: string, done: boolean, form: MaytasReview["form"] = null): MaytasReview => ({
  visitId,
  type: "Progress Review",
  plannedDate,
  actualDate: done ? plannedDate : null,
  outcome: done ? "Completed" : null,
  staff: "Alex Morgan",
  url: `https://maytas.example/etrack/Visits/TrVisit/${visitId}`,
  form,
});

/** Reviews that fit the sample rows: the next one is queued, and the last one falls inside the rows, so some KSBs have no evidence since then. */
export const sampleReviews: MaytasReview[] = [
  review("V-1004", "2026-11-25", false, {
    name: "Progress Review",
    status: "Not Started",
    dueDate: "2026-11-25",
    url: "https://maytas.example/etrack/CustomTab/VisitDataCollection?formRecordId=3",
  }),
  review("V-1003", "2026-09-23", true),
  review("V-1002", "2026-06-17", true),
  review("V-1001", "2026-03-11", true),
];

const row = (
  date: string,
  hours: number,
  where: string,
  method: string,
  describe: string,
  reflect: string,
  ksbs: string[],
  anythingElse: string | null = null,
): EntryContent => ({ date, centihours: Math.round(hours * 100), where, method, describe, reflect, anythingElse, ksbs });

/** Rows that a student in the second year could have in Maytas. */
export const sampleRows: EntryContent[] = [
  row("2026-09-15", 6, "University", "Workplace Training", "Lecture and lab: relational database design", "Normalising to third normal form removed the update anomalies in our sample schema.", ["K5"]),
  row("2026-09-18", 3.5, "Workplace", "Job Related Projects", "Built the export screen for the billing dashboard", "Learnt how to stream a large CSV instead of building it in memory.", ["S2", "S11"]),
  row("2026-09-22", 1, "Workplace", "Mentoring", "Code review session with my mentor", "Smaller pull requests get faster and better reviews.", ["B4", "K1"]),
  row("2026-09-29", 6, "University", "Workplace Training", "Lecture and lab: software testing strategies", "The difference between a stub and a mock, and when each one helps.", ["K11"]),
  row("2026-10-02", 2.25, "Other", "Self-directed study", "Read about the repository and unit of work patterns", "A repository hides the query language from the domain code.", ["K8", "B7"]),
  row("2026-10-06", 4, "Workplace", "Performing New Elements of The Job", "First on-call shadow shift", "How alerts are routed and how the runbook is used during an incident.", ["B1", "S7"]),
  row("2026-10-09", 1.5, "Other", "Online Training", "Course module: Git branching strategies", "Trunk-based development needs feature flags to stay safe.", ["S14"]),
  row("2026-10-13", 6, "University", "Workplace Training", "Lecture and lab: design patterns", "Strategy and observer patterns, and the cost of too much indirection.", ["K8"]),
  row("2026-10-16", 3, "Workplace", "Job Related Projects", "Added integration tests to the payments service", "Tests against a real database caught a time zone bug that mocks hid.", ["K11", "S7"]),
  row("2026-10-21", 0.75, "Workplace", "Meetings", "Sprint retrospective", "We agreed to limit work in progress to two items each.", ["K1", "B4"]),
  row("2026-10-27", 2, "Other", "Research", "Compared three CI providers for the team", "Caching dependencies matters more than the speed of the runner.", ["S14", "B7"], "Wrote a one-page summary for the team lead."),
  row("2026-11-03", 6, "University", "Workplace Training", "Lecture and lab: user interface design", "Accessible colour contrast and keyboard navigation from the start.", ["S2"]),
];

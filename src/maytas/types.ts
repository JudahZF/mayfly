import type { EntryContent, MaytasRow } from "../shared/entry";

export type { MaytasRow };

export type MaytasProfile = {
  targetCentihours: number;
  standard: string;
  /** Last day of the programme (YYYY-MM-DD), if Maytas shows one. */
  endDate: string | null;
  ksbs: { code: string; text: string }[];
  methods: string[];
  wheres: string[];
};

/** One engagement from the Maytas Engagements page, such as a progress review. Dates are YYYY-MM-DD. */
export type MaytasReview = {
  visitId: string;
  type: string;
  plannedDate: string;
  actualDate: string | null;
  outcome: string | null;
  staff: string | null;
  /** The engagement in Maytas, where a completed review keeps its PDF. */
  url: string;
  /** The form that Maytas asks the learner to complete for this engagement, if one is queued. */
  form: { name: string; status: string; dueDate: string | null; url: string } | null;
};

export interface Maytas {
  /** Opens a session. Maytas allows one session per account, so a new one ends any other. */
  signIn(): Promise<MaytasSession>;
}

/**
 * Write calls (`addOtj`, `editOtj`, `deleteOtj`) may resolve, reject or hang.
 * The caller must treat all three the same: the outcome is unknown.
 * Only `listOtj` tells the truth.
 */
export interface MaytasSession {
  /** True while an earlier save may still reach Maytas. No write may start then. */
  saving?(): boolean;
  getProfile(): Promise<MaytasProfile>;
  listOtj(): Promise<MaytasRow[]>;
  /** The newest engagements first, with any form that is queued for the learner. */
  listReviews(): Promise<MaytasReview[]>;
  addOtj(row: EntryContent): Promise<void>;
  editOtj(rowId: string, row: EntryContent): Promise<void>;
  deleteOtj(rowId: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Maytas refused the credentials. Repeated attempts can lock the account. */
export class SignInFailed extends Error {
  override name = "SignInFailed";
}

/** Network error, time-out, outage or a session that ended. Try again later. */
export class MaytasUnavailable extends Error {
  override name = "MaytasUnavailable";
}

/** The page does not look as expected. Writing is not safe until a person checks. */
export class LayoutChanged extends Error {
  override name = "LayoutChanged";
}

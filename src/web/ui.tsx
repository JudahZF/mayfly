import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "./api";
import {
  type AppState,
  describeSync,
  type Entry,
  errorText,
  firstLine,
  formatDate,
  formatHours,
  formatMoment,
  refreshEntries,
  type SyncState,
  type Tone,
  unwrap,
} from "./lib";

export function SyncChip({ sync }: { sync: SyncState }) {
  const { tone, label, detail } = describeSync(sync);
  return (
    <span key={label} className={`chip chip-${tone}`} title={detail}>
      {label}
    </span>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-rose bg-rose-soft px-3 py-2 text-sm text-rose">
      {errorText(error)}
    </p>
  );
}

/** One line of an entry list: date, hours, method, first line of the description, sync state. */
export function EntryRow({ entry, showDate = true }: { entry: Entry; showDate?: boolean }) {
  return (
    <Link
      to="/entries/$id"
      params={{ id: entry.id }}
      className="flex items-center gap-3 px-1 py-2 text-ink no-underline hover:bg-code"
    >
      <span className="w-[5.5rem] shrink-0 text-sm leading-tight">
        {showDate && <span className="block text-mid">{formatDate(entry.date)}</span>}
        <span className="block font-semibold tabular-nums">{formatHours(entry.centihours)} h</span>
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate">{firstLine(entry.describe)}</span>
        <span className="block truncate text-sm text-mid">{entry.method}</span>
      </span>
      <SyncChip sync={entry.sync} />
    </Link>
  );
}

type BridgeSummary = { tone: Tone; label: string; detail: string };

/** The single status of the bridge that the user sees: in sync, sending, paused or needs you. */
export function bridgeSummary({ bridge }: AppState): BridgeSummary {
  const n = (state: string) => bridge.counts[state] ?? 0;
  const entries = (count: number) => (count === 1 ? "1 entry" : `${count} entries`);
  const moving = n("queued") + n("writing") + n("checking");
  if (bridge.state === "syncPaused") {
    return {
      tone: "queued",
      label: "Sync paused",
      detail: moving > 0 ? `You paused sync. ${entries(moving)} wait to go to Maytas.` : "You paused sync. Mayfly does not sign in to Maytas.",
    };
  }
  if (bridge.state === "paused") {
    return { tone: "problem", label: "Sync stopped", detail: bridge.reason ?? "Mayfly stopped sync to keep your account safe." };
  }
  if (n("needsYou") > 0) {
    const count = n("needsYou");
    return { tone: "problem", label: "Needs you", detail: `${entries(count)} ${count === 1 ? "needs" : "need"} you before Mayfly can finish ${count === 1 ? "it" : "them"}.` };
  }
  if (bridge.state === "waiting") {
    const next = bridge.waitUntil === null ? "" : ` Mayfly tries again ${formatMoment(bridge.waitUntil)}.`;
    return { tone: "queued", label: "Waiting for Maytas", detail: `${bridge.reason ?? "Maytas did not answer."}${next}` };
  }
  if (moving > 0 || bridge.state === "working") {
    return {
      tone: "sending",
      label: "Sending",
      detail: moving > 0 ? `${entries(moving)} on the way to Maytas.` : "Mayfly is reading Maytas.",
    };
  }
  return {
    tone: "done",
    label: "In sync",
    detail: bridge.lastReconcileAt === null ? "Mayfly has not read Maytas yet." : `Checked against Maytas ${formatMoment(bridge.lastReconcileAt)}.`,
  };
}

/** Clears a pause: the user's switch or a stop set by the bridge. */
export function useResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (state: AppState) => {
      if (state.bridge.state === "syncPaused") await unwrap(api.api.settings.$patch({ json: { syncPaused: false } }));
      else await unwrap(api.api.bridge.resume.$post());
    },
    onSettled: () => refreshEntries(qc),
  });
}

/** Runs a full read of Maytas, then the queue. */
export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.api.sync.$post()),
    onSettled: () => refreshEntries(qc),
  });
}

/** Shown where the form lists are needed but the Maytas profile is not read yet. */
export function NoProfile({ title }: { title: string }) {
  const sync = useSyncNow();
  return (
    <div className="max-w-xl">
      <h1>{title}</h1>
      <p className="mt-3">
        Mayfly has not read your Maytas profile yet. It needs it for the lists of places, methods and KSBs. It reads it at the first sync.
      </p>
      <button type="button" className="btn btn-primary mt-4" disabled={sync.isPending} onClick={() => sync.mutate()}>
        Sync now
      </button>
      <Problem error={sync.error} />
    </div>
  );
}

/** Status line with the one action that fixes it. */
export function BridgeStatus({ state, compact = false }: { state: AppState; compact?: boolean }) {
  const summary = bridgeSummary(state);
  const resume = useResume();
  const paused = state.bridge.state === "syncPaused" || state.bridge.state === "paused";
  return (
    <div aria-live="polite" className={compact ? "" : "flex flex-wrap items-center gap-x-3 gap-y-2"}>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span key={summary.label} className={`chip chip-${summary.tone}`}>
          {summary.label}
        </span>
        {!compact && <span className="min-w-0 text-sm text-mid">{summary.detail}</span>}
      </span>
      {!compact && paused && (
        <button type="button" className="btn btn-small" disabled={resume.isPending} onClick={() => resume.mutate(state)}>
          Resume sync
        </button>
      )}
      {!compact && summary.label === "Needs you" && (
        <Link to="/needs-you" className="btn btn-small">
          Resolve
        </Link>
      )}
      {!compact && <Problem error={resume.error} />}
    </div>
  );
}

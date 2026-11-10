import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { InferResponseType } from "hono/client";
import { useState } from "react";
import { api } from "../api";
import { formatMoment, refreshEntries, stateQuery, unwrap, useRefreshMs } from "../lib";
import { BridgeStatus, PageHead, Problem, useSyncNow } from "../ui";

export const Route = createFileRoute("/sync")({
  component: Sync,
});

type LogLine = InferResponseType<typeof api.api.log.$get, 200>["log"][number];

const kindText: Record<string, string> = {
  signIn: "Signed in to Maytas",
  signOut: "Signed out of Maytas",
  "signIn.failed": "Sign-in failed",
  unavailable: "Maytas did not answer",
  pause: "Sync stopped",
  resume: "Sync resumed",
  reconcile: "Read all rows in Maytas",
  "reconcile.flag": "Marked as needs you",
  "reconcile.link": "Linked to a Maytas row",
  "reconcile.duplicate": "Found a duplicate in Maytas",
  "reviews.failed": "Could not read reviews",
  recover: "Checking after a restart",
  "write.add": "Sent a new row",
  "write.edit": "Sent a change",
  "write.delete": "Sent a delete",
  inMaytas: "Confirmed in Maytas",
  removed: "Confirmed deleted",
  needsYou: "Needs you",
  queued: "Back in the queue",
  checking: "Checking Maytas",
  "entry.add": "Entry added",
  "entry.draft": "Draft added",
  "entry.update": "Entry changed",
  "entry.delete": "Entry deleted",
  "entry.restore": "Entry restored",
  "entry.approve": "Draft approved",
  "entry.resolve": "Resolved",
  settings: "Settings changed",
};

const sourceText = { app: "You", agent: "Agent", bridge: "Mayfly" } as const;

const settingText: Record<string, string> = {
  "syncPaused:true": "Paused sync",
  "syncPaused:false": "Turned sync on",
  "agentMode:drafts": "Agent mode: drafts",
  "agentMode:fullAccess": "Agent mode: full access",
};

/** Log details that hold JSON (a reconcile report, a settings change) in plain words. */
function detailText(line: LogLine) {
  if (line.kind !== "reconcile" && line.kind !== "settings") return line.detail;
  try {
    const data: unknown = JSON.parse(line.detail);
    if (typeof data !== "object" || data === null) return line.detail;
    return Object.entries(data)
      .map(([k, v]) => (line.kind === "settings" ? (settingText[`${k}:${v}`] ?? `${k}: ${v}`) : `${v} ${k}`))
      .join(", ");
  } catch {
    return line.detail;
  }
}

function Sync() {
  const qc = useQueryClient();
  const state = useQuery(stateQuery);
  const [limit, setLimit] = useState(100);
  const log = useQuery({
    queryKey: ["log", limit],
    queryFn: async () => (await unwrap(api.api.log.$get({ query: { limit: String(limit) } }))).log,
    refetchInterval: useRefreshMs(),
    placeholderData: (previous) => previous,
  });
  const pause = useMutation({
    mutationFn: (syncPaused: boolean) => unwrap(api.api.settings.$patch({ json: { syncPaused } })),
    onSettled: () => refreshEntries(qc),
  });
  const syncNow = useSyncNow();

  if (!state.data) return <Problem error={state.error} />;
  const { bridge, settings } = state.data;
  const paused = settings.syncPaused;

  return (
    <div className="max-w-3xl">
      <PageHead title="Sync" />
      <section className="panel px-3 py-3">
        <BridgeStatus state={state.data} />
        <p className="hint mt-2">
          {bridge.lastReconcileAt === null ? "Mayfly has not read Maytas yet." : `Last full read of Maytas ${formatMoment(bridge.lastReconcileAt)}.`}{" "}
          {bridge.signedIn ? "Mayfly is signed in to Maytas now." : "Mayfly is not signed in to Maytas now."}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" disabled={syncNow.isPending || paused} onClick={() => syncNow.mutate()}>
            Sync now
          </button>
          <span className="hint">Reads every row in Maytas, compares it with Mayfly, then sends what waits.</span>
        </div>
        <Problem error={syncNow.error} />
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="pause-label">Pause sync</h2>
          <button
            type="button"
            role="switch"
            aria-checked={paused}
            aria-labelledby="pause-label"
            disabled={pause.isPending}
            onClick={() => pause.mutate(!paused)}
            className={`relative h-8 w-14 shrink-0 rounded-full border transition-colors ${paused ? "border-amber bg-amber" : "border-line bg-code"}`}
          >
            <span className={`absolute top-1 left-1 size-5.5 rounded-full bg-raised shadow transition-transform ${paused ? "translate-x-6" : ""}`} />
          </button>
        </div>
        <p className="mt-1 max-w-prose text-sm">
          Maytas allows one session per account. When Mayfly signs in, your own Maytas session ends. Pause sync while you use Maytas yourself, then
          turn it off again. New entries wait in the queue while sync is paused.
        </p>
        <p className="mt-1 text-sm font-semibold">{paused ? "Sync is paused. Mayfly does not sign in to Maytas." : "Sync is on."}</p>
        <Problem error={pause.error} />
      </section>

      <section className="mt-8">
        <h2>Bridge log</h2>
        <p className="hint">Every action of the bridge, of you and of your agents, newest first.</p>
        <Problem error={log.error} />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left">
                <th className="py-1.5 pr-3 font-semibold">When</th>
                <th className="py-1.5 pr-3 font-semibold">Who</th>
                <th className="py-1.5 pr-3 font-semibold">What</th>
                <th className="py-1.5 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(log.data ?? []).map((line) => (
                <tr key={line.id} className="border-b border-line align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-mid">{formatMoment(line.at)}</td>
                  <td className="py-1.5 pr-3">{sourceText[line.source]}</td>
                  <td className="py-1.5 pr-3">
                    {line.entryId ? (
                      <Link to="/entries/$id" params={{ id: line.entryId }}>
                        {kindText[line.kind] ?? line.kind}
                      </Link>
                    ) : (
                      (kindText[line.kind] ?? line.kind)
                    )}
                  </td>
                  <td className="py-1.5 break-words text-mid">{detailText(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {log.data?.length === limit && limit < 500 && (
          <button type="button" className="btn btn-small mt-3" onClick={() => setLimit((l) => l + 100)}>
            Show older
          </button>
        )}
      </section>
    </div>
  );
}

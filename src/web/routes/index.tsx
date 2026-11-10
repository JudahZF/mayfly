import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../api";
import {
  type AppState,
  type Entry,
  entriesQuery,
  formatDate,
  formatHours,
  formDeadline,
  refreshEntries,
  reviewsQuery,
  shiftDate,
  stateQuery,
  todayIso,
  unwrap,
  useRefreshMs,
  weekStart,
} from "../lib";
import { BridgeStatus, EntryRow, Problem } from "../ui";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const state = useQuery(stateQuery);
  const entries = useQuery({ ...entriesQuery(), refetchInterval: useRefreshMs() });
  if (!state.data) return <Problem error={state.error} />;
  const all = entries.data ?? [];
  const drafts = all.filter((e) => e.sync.state === "draft");
  const needsYou = all.filter((e) => e.sync.state === "needsYou");
  const recent = all.filter((e) => e.sync.state !== "draft").slice(0, 8);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Home</h1>
      {state.data.settings.agentMode === "fullAccess" && (
        <p className="rounded-lg border border-rose px-3 py-2 text-sm">
          <strong className="text-rose">Agents have full access.</strong> They can add, change and delete entries in Maytas without asking you.{" "}
          <Link to="/settings">Change this</Link>
        </p>
      )}
      <section aria-label="Sync status" className="panel px-3 py-2.5">
        <BridgeStatus state={state.data} />
      </section>
      <NextReview />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <Progress state={state.data} entries={all} />
          <Weeks state={state.data} entries={all} />
        </div>
        <div className="space-y-8">
          {needsYou.length > 0 && (
            <section>
              <h2 className="text-rose">Needs you</h2>
              <p className="hint">Mayfly stopped these entries because Maytas does not match. Nothing more is sent until you choose.</p>
              <div className="rows mt-2 border-y border-line">
                {needsYou.map((e) => (
                  <EntryRow key={e.id} entry={e} />
                ))}
              </div>
              <Link to="/needs-you" className="btn btn-small mt-2">
                Resolve
              </Link>
            </section>
          )}
          {drafts.length > 0 && <Drafts drafts={drafts} />}
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h2>Recent entries</h2>
              <Link to="/entries" className="text-sm">
                All entries
              </Link>
            </div>
            {entries.isPending ? (
              <p className="hint mt-2">Loading entries…</p>
            ) : recent.length === 0 ? (
              <p className="mt-2">
                No entries yet. <Link to="/log">Log your first hours</Link>.
              </p>
            ) : (
              <div className="rows mt-2 border-y border-line">
                {recent.map((e) => (
                  <EntryRow key={e.id} entry={e} />
                ))}
              </div>
            )}
            <Problem error={entries.error} />
          </section>
        </div>
      </div>
    </div>
  );
}

/** One line about the next progress review, only when Maytas has one planned. */
function NextReview() {
  const prep = useQuery(reviewsQuery).data?.prep;
  if (!prep?.next) return null;
  const deadline = formDeadline(prep.next);
  const { since } = prep;
  return (
    <Link
      to="/reviews"
      className={`panel block px-3 py-2.5 text-ink no-underline hover:border-mid ${deadline.urgent ? "border-rose" : ""}`}
    >
      <strong>Progress review on {formatDate(prep.next.plannedDate)}.</strong>{" "}
      <span className={deadline.urgent ? "font-semibold text-rose" : undefined}>{deadline.text}</span>
      <span className="hint block">
        Since the last one: {formatHours(since.confirmedCentihours + since.pendingCentihours + since.needsYouCentihours)} h, {since.ksbs.length} KSBs.
      </span>
    </Link>
  );
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** Hours against the target, with a line at where the user should be today. */
function Progress({ state, entries }: { state: AppState; entries: Entry[] }) {
  const p = state.progress;
  const target = p.targetCentihours;
  if (target === null) {
    return (
      <section>
        <p className="font-serif text-4xl font-semibold">{formatHours(p.confirmedCentihours)} h</p>
        <p className="hint mt-1">Mayfly does not know your target yet. It reads it from Maytas at the first sync.</p>
      </section>
    );
  }
  const counted = entries.filter((e) => e.sync.state !== "draft");
  const start = counted.reduce<string | null>((min, e) => (min === null || e.date < min ? e.date : min), null);
  const done = p.confirmedCentihours + p.pendingCentihours;
  const share = (n: number) => `${Math.min(100, (n / target) * 100)}%`;
  const expected =
    start && p.endDate ? target * Math.min(1, Math.max(0, daysBetween(start, todayIso()) / daysBetween(start, p.endDate))) : null;
  const gap = expected === null ? null : done - expected;

  return (
    <section aria-label="Hours against your target">
      <p className="font-serif text-5xl leading-none font-semibold tabular-nums">
        {formatHours(p.confirmedCentihours)}
        <span className="ml-2 font-sans text-base font-normal text-mid">of {formatHours(target)} hours in Maytas</span>
      </p>
      <div className="relative mt-4 h-3 rounded-full bg-code" role="img" aria-label={`${formatHours(done)} of ${formatHours(target)} hours`}>
        <div className="absolute inset-y-0 left-0 overflow-hidden rounded-full" style={{ width: share(done) }}>
          <div className="absolute inset-y-0 left-0 bg-river transition-[width] duration-500" style={{ width: `${(p.confirmedCentihours / Math.max(done, 1)) * 100}%` }} />
          <div
            className="absolute inset-y-0 right-0 bg-amber"
            style={{ width: `${(p.pendingCentihours / Math.max(done, 1)) * 100}%`, opacity: 0.55 }}
          />
        </div>
        {expected !== null && <div className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-ink" style={{ left: share(expected) }} />}
      </div>
      {gap !== null && (
        <p className="mt-3">
          The line is where you should be today.{" "}
          <strong>
            You are {formatHours(Math.abs(Math.round(gap / 100) * 100))} h {gap >= 0 ? "ahead" : "behind"}.
          </strong>
        </p>
      )}
      <ul className="hint mt-1.5 space-y-0.5">
        {p.pendingCentihours > 0 && <li>{formatHours(p.pendingCentihours)} h more are on the way to Maytas (amber).</li>}
        {p.pacePerWeekCentihours !== null && p.endDate && (
          <li>
            You need {formatHours(p.pacePerWeekCentihours)} h a week until {formatDate(p.endDate, { weekday: false })}.
          </li>
        )}
        {start && <li>Pace is counted from your first entry, on {formatDate(start, { weekday: false })}.</li>}
        {p.draftCentihours > 0 && <li>Drafts ({formatHours(p.draftCentihours)} h) do not count until you approve them.</li>}
      </ul>
    </section>
  );
}

/** The last eight weeks, against the weekly pace. */
function Weeks({ state, entries }: { state: AppState; entries: Entry[] }) {
  const thisWeek = weekStart(todayIso());
  const weeks = Array.from({ length: 8 }, (_, i) => shiftDate(thisWeek, (i - 7) * 7));
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (e.sync.state === "draft") continue;
    const w = weekStart(e.date);
    totals.set(w, (totals.get(w) ?? 0) + e.centihours);
  }
  const pace = state.progress.pacePerWeekCentihours;
  const top = Math.max(pace ?? 0, ...weeks.map((w) => totals.get(w) ?? 0), 100);
  return (
    <section aria-labelledby="weeks-title">
      <h2 id="weeks-title">Last eight weeks</h2>
      {pace !== null && <p className="hint">The line is the pace you need: {formatHours(pace)} h a week.</p>}
      <div className="relative mt-3 flex h-28 items-end gap-1.5 border-b border-line">
        {pace !== null && (
          <div className="absolute inset-x-0 border-t border-dashed border-ink" style={{ bottom: `${(pace / top) * 100}%` }} aria-hidden />
        )}
        {weeks.map((w) => {
          const hours = totals.get(w) ?? 0;
          return (
            <div key={w} className="flex h-full flex-1 flex-col justify-end" title={`Week of ${formatDate(w, { weekday: false })}: ${formatHours(hours)} h`}>
              <span className="mb-0.5 text-center text-xs tabular-nums text-mid">{hours > 0 ? formatHours(hours) : ""}</span>
              <div
                className={`rounded-t-sm ${pace !== null && hours >= pace ? "bg-river" : "bg-river/45"}`}
                style={{ height: `${(hours / top) * 100}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1.5">
        {weeks.map((w) => (
          <span key={w} className="flex-1 overflow-hidden text-center text-[11px] whitespace-nowrap text-mid">
            {formatDate(w, { weekday: false }).replace(/ \d{4}$/, "")}
          </span>
        ))}
      </div>
    </section>
  );
}

function Drafts({ drafts }: { drafts: Entry[] }) {
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () => unwrap(api.api.entries.approve.$post({ json: { ids: drafts.map((d) => d.id) } })),
    onSettled: () => refreshEntries(qc),
  });
  const hours = drafts.reduce((sum, d) => sum + d.centihours, 0);
  return (
    <section>
      <h2>Drafts from your agent</h2>
      <p className="hint">
        {drafts.length === 1 ? "1 draft" : `${drafts.length} drafts`}, {formatHours(hours)} h. Open one to read or change it. Approve to send them to Maytas.
      </p>
      <div className="rows mt-2 border-y border-line">
        {drafts.slice(0, 6).map((e) => (
          <EntryRow key={e.id} entry={e} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary btn-small" disabled={approve.isPending} onClick={() => approve.mutate()}>
          {drafts.length === 1 ? "Approve draft" : `Approve all ${drafts.length}`}
        </button>
        {drafts.length > 6 && (
          <Link to="/entries" search={{ state: "draft" }} className="text-sm">
            See all drafts
          </Link>
        )}
      </div>
      <Problem error={approve.error} />
    </section>
  );
}

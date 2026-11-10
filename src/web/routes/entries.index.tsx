import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { syncStateNames } from "../../shared/entry";
import { type Entry, entriesQuery, formatDate, formatHours, syncFilterOptions, useRefreshMs, weekStart } from "../lib";
import { EntryRow, PageHead, Problem } from "../ui";

const search = z.object({
  q: z.string().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  state: z.enum(syncStateNames).optional(),
  deleted: z.boolean().optional(),
});

export const Route = createFileRoute("/entries/")({
  validateSearch: search,
  component: Entries,
});

function Entries() {
  const filter = Route.useSearch();
  const navigate = Route.useNavigate();
  const set = (patch: Partial<z.output<typeof search>>) =>
    navigate({ search: (old) => ({ ...old, ...patch }), replace: true });
  const [text, setText] = useState(filter.q ?? "");
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filter.q ?? "") !== text.trim()) set({ q: text.trim() || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [text, filter.q]);

  const entries = useQuery({
    ...entriesQuery({ q: filter.q, from: filter.from, to: filter.to, state: filter.state, includeDeleted: filter.deleted || filter.state === "removed" }),
    refetchInterval: useRefreshMs(),
    placeholderData: (previous) => previous,
  });
  const list = entries.data ?? [];
  const total = list.filter((e) => e.deletedAt === null).reduce((sum, e) => sum + e.centihours, 0);
  const filtered = Boolean(filter.q || filter.from || filter.to || filter.state || filter.deleted);

  return (
    <div className="max-w-3xl">
      <PageHead title="Entries">
        <Link to="/log" className="btn btn-primary btn-small hidden sm:inline-flex">
          Log hours
        </Link>
      </PageHead>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_9.5rem_9.5rem_9rem]">
        <div className="col-span-2 sm:col-span-1">
          <label className="label" htmlFor="q">
            Search
          </label>
          <input id="q" type="search" className="input" placeholder="Words from what you did or learned" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="from">
            From
          </label>
          <input id="from" type="date" className="input" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        </div>
        <div>
          <label className="label" htmlFor="to">
            To
          </label>
          <input id="to" type="date" className="input" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        </div>
        <div>
          <label className="label" htmlFor="state">
            State
          </label>
          <select
            id="state"
            className="input"
            value={filter.state ?? ""}
            onChange={(e) => set({ state: syncStateNames.find((s) => s === e.target.value) })}
          >
            <option value="">Any</option>
            {syncFilterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-end gap-2 pb-2.5 text-sm sm:col-span-4">
          <input type="checkbox" className="size-4 accent-river" checked={filter.deleted ?? false} onChange={(e) => set({ deleted: e.target.checked || undefined })} />
          Show deleted entries
        </label>
      </div>

      <p className="hint mt-4 mb-1" aria-live="polite">
        {entries.isPending
          ? "Loading entries…"
          : `${list.length === 1 ? "1 entry" : `${list.length} entries`}, ${formatHours(total)} h.`}
        {filtered && (
          <>
            {" "}
            <button type="button" className="text-river underline underline-offset-3" onClick={() => { setText(""); navigate({ search: {}, replace: true }); }}>
              Clear filters
            </button>
          </>
        )}
      </p>
      <Problem error={entries.error} />
      {!entries.isPending && list.length === 0 && (
        <p className="mt-4">{filtered ? "No entries match. Change the filters." : "No entries yet."}</p>
      )}
      <Weeks entries={list} />
    </div>
  );
}

/** Entries grouped by week, newest first, with a total for each week. */
function Weeks({ entries }: { entries: Entry[] }) {
  const groups: { week: string; entries: Entry[] }[] = [];
  for (const e of entries) {
    const week = weekStart(e.date);
    const group = groups.at(-1);
    if (group?.week === week) group.entries.push(e);
    else groups.push({ week, entries: [e] });
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.week} aria-label={`Week of ${formatDate(g.week, { weekday: false })}`}>
          <h2 className="flex items-baseline justify-between border-b-2 border-ink pt-2 pb-1 font-sans text-sm font-semibold">
            <span>Week of {formatDate(g.week, { weekday: false })}</span>
            <span className="tabular-nums">
              {formatHours(g.entries.filter((e) => e.deletedAt === null).reduce((s, e) => s + e.centihours, 0))} h
            </span>
          </h2>
          <div className="rows">
            {g.entries.map((e) => (
              <EntryRow key={e.id} entry={e} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

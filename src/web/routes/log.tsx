import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { EntryFields } from "../../shared/entry";
import { api } from "../api";
import { blankValues, EntryForm, type FormValues, valuesFrom } from "../entry-form";
import {
  type Entry,
  entriesQuery,
  entryQuery,
  formatDate,
  formatHours,
  Refused,
  refreshEntries,
  stateQuery,
  todayIso,
  unwrap,
  useRefreshMs,
  warningText,
} from "../lib";
import { NoProfile, PageHead, Problem, SyncChip } from "../ui";

export const Route = createFileRoute("/log")({
  validateSearch: z.object({ copy: z.string().optional() }),
  component: Log,
});

type Saved = { id: string; created: boolean; warnings: string[]; entry: Entry };

const lastUsed = (entries: Entry[]) =>
  entries.filter((e) => e.source === "app").reduce<Entry | undefined>((last, e) => (!last || e.createdAt > last.createdAt ? e : last), undefined);

function Log() {
  const { copy } = Route.useSearch();
  const qc = useQueryClient();
  const state = useQuery(stateQuery);
  const entries = useQuery({ ...entriesQuery(), refetchInterval: useRefreshMs() });
  const source = useQuery({ ...entryQuery(copy ?? ""), enabled: copy !== undefined });
  const [round, setRound] = useState(0);
  const [next, setNext] = useState<FormValues | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  const add = useMutation({
    mutationFn: async (fields: EntryFields) => {
      const [result] = (await unwrap(api.api.entries.$post({ json: { entries: [fields] } }))).results;
      if (!result) throw new Error("Mayfly did not answer for this entry. Look in Entries before you try again.");
      if (!result.ok) throw new Refused(result);
      return result.value;
    },
    onSuccess: (value, fields) => {
      setSaved({ id: value.entry.id, created: value.created, warnings: value.warnings, entry: value.entry });
      setNext({ ...blankValues({ where: fields.where, method: fields.method }), date: fields.date });
      setRound((r) => r + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onSettled: () => refreshEntries(qc),
  });

  const profile = state.data?.profile;
  if (state.isPending || entries.isPending || (copy && source.isPending)) return <PageHead title="Log hours" />;
  if (!profile) return <NoProfile title="Log hours" />;

  const last = lastUsed(entries.data ?? []);
  const initial =
    next ??
    (copy && source.data
      ? { ...valuesFrom(source.data), date: todayIso() }
      : blankValues(last && { where: last.where, method: last.method }));
  const live = saved && (entries.data?.find((e) => e.id === saved.id) ?? saved.entry);

  return (
    <div className="max-w-2xl">
      <PageHead title={copy && round === 0 ? "Log hours from a copy" : "Log hours"} />
      {copy && round === 0 && source.data && (
        <p className="hint -mt-2 mb-4">
          Copied from {formatDate(source.data.date)}. The date is set to today. Change what is different.
        </p>
      )}
      {live && saved && (
        <div aria-live="polite" key={saved.id + round} className="panel saved-flash mb-5 px-3 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong>{saved.created ? "Saved." : "You logged this already."}</strong>
            <SyncChip sync={live.sync} />
            <Link to="/entries/$id" params={{ id: live.id }} className="text-sm">
              {formatDate(live.date)}, {formatHours(live.centihours)} h
            </Link>
          </div>
          <p className="hint mt-1">
            {saved.created
              ? "Mayfly keeps it now and sends it to Maytas in the background."
              : "An entry with this date, hours and description exists. Mayfly kept that one and added nothing."}
          </p>
          {saved.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 border-l-2 border-amber pl-3 text-sm">
              {saved.warnings.map(warningText).map((w) => (
                <li key={w.text}>
                  {w.text}{" "}
                  {w.entryId && (
                    <Link to="/entries/$id" params={{ id: w.entryId }}>
                      Open it
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Problem error={source.error} />
      <EntryForm
        key={`${copy ?? "new"}-${round}`}
        profile={profile}
        initial={initial}
        submitLabel="Save entry"
        pending={add.isPending}
        onSubmit={(fields) => add.mutate(fields)}
        footer={add.error ? <Problem error={add.error} /> : <span className="hint hidden sm:inline">Saved at once. Sent to Maytas in the background.</span>}
      />
    </div>
  );
}

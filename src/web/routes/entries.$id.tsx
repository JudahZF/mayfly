import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { EntryFields } from "../../shared/entry";
import { api } from "../api";
import { EntryForm, valuesFrom } from "../entry-form";
import {
  describeSync,
  type Entry,
  entryQuery,
  formatDate,
  formatHours,
  formatMoment,
  type Profile,
  refreshEntries,
  sourceText,
  stateQuery,
  unwrap,
  useRefreshMs,
} from "../lib";
import { Problem, SyncChip } from "../ui";

export const Route = createFileRoute("/entries/$id")({
  component: EntryPage,
});

function EntryPage() {
  const { id } = Route.useParams();
  const entry = useQuery({ ...entryQuery(id), refetchInterval: useRefreshMs() });
  const profile = useQuery(stateQuery).data?.profile ?? null;
  const [editing, setEditing] = useState(false);

  if (entry.isPending) return <p className="hint">Loading the entry…</p>;
  if (!entry.data) {
    return (
      <div>
        <Problem error={entry.error} />
        <Link to="/entries" className="mt-3 inline-block">
          Back to entries
        </Link>
      </div>
    );
  }
  const e = entry.data;
  return (
    <div className="max-w-2xl">
      <Link to="/entries" className="text-sm">
        All entries
      </Link>
      <header className="mt-1 mb-4">
        <h1>
          {formatDate(e.date)}, {formatHours(e.centihours)} h
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <SyncChip sync={e.sync} />
          <span className="text-sm text-mid">{describeSync(e.sync).detail}</span>
        </p>
      </header>
      {editing && profile ? (
        <Edit entry={e} profile={profile} onDone={() => setEditing(false)} />
      ) : (
        <>
          <Details entry={e} profile={profile} />
          <Actions entry={e} onEdit={() => setEditing(true)} />
        </>
      )}
    </div>
  );
}

function Details({ entry: e, profile }: { entry: Entry; profile: Profile | null }) {
  const ksbText = new Map(profile?.ksbs.map((k) => [k.code, k.text]));
  const row = (label: string, value: ReactNode) => (
    <div className="grid gap-x-4 py-2 sm:grid-cols-[9rem_1fr]">
      <dt className="text-sm font-semibold text-mid">{label}</dt>
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
  return (
    <dl className="rows border-y border-line">
      {row("What you did", e.describe)}
      {row("What you learned", e.reflect)}
      {row("Where", e.where)}
      {row("Method", e.method)}
      {e.startTime && row("Start time", e.startTime)}
      {e.anythingElse && row("Anything else", e.anythingElse)}
      {row(
        "KSBs",
        e.ksbs.length === 0 ? (
          <span className="text-mid">None</span>
        ) : (
          <ul className="space-y-0.5">
            {e.ksbs.map((k) => (
              <li key={k}>
                <strong>{k}</strong> <span className="text-sm text-mid">{ksbText.get(k)}</span>
              </li>
            ))}
          </ul>
        ),
      )}
      {row("Added", `${sourceText[e.source]}, ${formatMoment(e.createdAt)}.`)}
      {e.updatedAt !== e.createdAt && row("Last change", formatMoment(e.updatedAt))}
    </dl>
  );
}

function useEntryAction<T>(entry: Entry, call: (id: string) => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call(entry.id),
    onSettled: () => refreshEntries(qc),
  });
}

function Actions({ entry: e, onEdit }: { entry: Entry; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const param = (id: string) => ({ param: { id } });
  const remove = useEntryAction(e, (id) => unwrap(api.api.entries[":id"].$delete(param(id))));
  const restore = useEntryAction(e, (id) => unwrap(api.api.entries[":id"].restore.$post(param(id))));
  const approve = useEntryAction(e, (id) => unwrap(api.api.entries.approve.$post({ json: { ids: [id] } })));
  const s = e.sync.state;
  const deleted = e.deletedAt !== null;
  const inMaytas = e.maytasRowId !== null || s === "inMaytas";

  if (s === "needsYou") {
    return (
      <div className="mt-5">
        <Link to="/needs-you" hash={e.id} className="btn btn-primary">
          Resolve this entry
        </Link>
      </div>
    );
  }
  if (deleted) {
    return (
      <div className="mt-5 space-y-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={restore.isPending} onClick={() => restore.mutate()}>
            Restore entry
          </button>
          <Link to="/log" search={{ copy: e.id }} className="btn">
            Copy entry
          </Link>
        </div>
        <p className="hint">Restore puts it back and sends it to Maytas again as a new row.</p>
        <Problem error={restore.error} />
      </div>
    );
  }
  return (
    <div className="mt-5 space-y-3">
      <div className="flex flex-wrap gap-2">
        {s === "draft" && (
          <button type="button" className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
            Approve draft
          </button>
        )}
        <button type="button" className="btn" onClick={onEdit}>
          Edit entry
        </button>
        <Link to="/log" search={{ copy: e.id }} className="btn">
          Copy entry
        </Link>
        <button type="button" className="btn btn-danger" aria-expanded={confirming} onClick={() => setConfirming(true)}>
          Delete entry
        </button>
      </div>
      {confirming && (
        <div className="rounded-lg border border-rose px-3 py-3" role="alertdialog" aria-label="Delete this entry?">
          <p>
            {inMaytas
              ? "Mayfly deletes the row in Maytas too, then checks it is gone."
              : "This entry is not in Maytas yet, so Mayfly removes it here only."}{" "}
            Mayfly keeps a copy, so you can restore it.
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn border-rose bg-rose text-paper" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
              Delete entry
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
      <Problem error={remove.error ?? approve.error} />
    </div>
  );
}

function Edit({ entry, profile, onDone }: { entry: Entry; profile: Profile; onDone: () => void }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (fields: EntryFields) => unwrap(api.api.entries[":id"].$patch({ param: { id: entry.id }, json: fields })),
    onSuccess: (updated) => {
      qc.setQueryData(entryQuery(entry.id).queryKey, updated);
      onDone();
    },
    onSettled: () => refreshEntries(qc),
  });
  return (
    <section aria-label="Edit entry">
      {entry.sync.state === "inMaytas" && (
        <p className="hint mb-4">This entry is in Maytas. Mayfly sends your change to the same row, then reads it back to check.</p>
      )}
      <EntryForm
        profile={profile}
        initial={valuesFrom(entry)}
        submitLabel="Save changes"
        pending={update.isPending}
        onSubmit={(fields) => update.mutate(fields)}
        footer={
          <>
            <button type="button" className="btn min-h-12" onClick={onDone}>
              Cancel
            </button>
            <Problem error={update.error} />
          </>
        }
      />
    </section>
  );
}

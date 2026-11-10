import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { ResolveInput } from "../../shared/entry";
import { api } from "../api";
import { type Entry, entriesQuery, formatDate, formatHours, refreshEntries, unwrap, useRefreshMs } from "../lib";
import { PageHead, Problem } from "../ui";

export const Route = createFileRoute("/needs-you")({
  component: NeedsYou,
});

function NeedsYou() {
  const entries = useQuery({ ...entriesQuery({ state: "needsYou", includeDeleted: true }), refetchInterval: useRefreshMs() });
  const list = entries.data ?? [];
  return (
    <div className="max-w-4xl">
      <PageHead title="Needs you" />
      <p className="-mt-2 mb-5 max-w-prose text-mid">
        Mayfly stops an entry when Maytas does not show it exactly once, or shows other content. Mayfly sends nothing more for it until you choose what to do.
      </p>
      <Problem error={entries.error} />
      {entries.isPending && <p className="hint">Loading…</p>}
      {!entries.isPending && list.length === 0 && (
        <p>
          Nothing needs you. <Link to="/">Back to Home</Link>
        </p>
      )}
      <div className="space-y-6">
        {list.map((e) => (
          <Case key={e.id} entry={e} />
        ))}
      </div>
    </div>
  );
}

type Row = Extract<Entry["sync"], { state: "needsYou" }>["rows"][number];

const retryText = {
  add: "Mayfly looks in Maytas again. If it finds the row once, it links to it. If not, it adds the entry once more.",
  edit: "Mayfly sends your version to the Maytas row again, then reads it back.",
  delete: "Mayfly deletes the row in Maytas again, then checks that it is gone.",
} as const;

function Case({ entry }: { entry: Entry }) {
  const qc = useQueryClient();
  const resolve = useMutation({
    mutationFn: (input: ResolveInput) => unwrap(api.api.entries[":id"].resolve.$post({ param: { id: entry.id }, json: input })),
    onSettled: () => refreshEntries(qc),
  });
  if (entry.sync.state !== "needsYou") return null;
  const { op, reason, rows } = entry.sync;
  const letter = (i: number) => String.fromCharCode(65 + i);
  const extra = rows.length > 1 ? " The other Maytas rows stay. Delete the extra ones in Maytas yourself." : "";

  return (
    <article id={entry.id} className="panel scroll-mt-4 px-4 py-4">
      <h2>
        <Link to="/entries/$id" params={{ id: entry.id }} className="text-ink">
          {formatDate(entry.date)}, {formatHours(entry.centihours)} h
        </Link>
      </h2>
      <p className="mt-1">
        <strong className="text-rose">{reason}</strong>
      </p>

      <Compare entry={entry} rows={rows} />

      <div className="rows mt-4 border-y border-line">
        <Choice action="Try again" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: "retry" })}>
          {retryText[op]}
        </Choice>
        {rows.map((row, i) => (
          <Fragment key={row.rowId}>
            <Choice
              action={rows.length > 1 ? `Use Maytas row ${letter(i)}` : "Use the Maytas version"}
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ action: "useMaytas", rowId: row.rowId })}
            >
              Mayfly copies {rows.length > 1 ? `row ${letter(i)}` : "the Maytas row"} into your entry and marks it In Maytas. Nothing is sent to Maytas.
              {extra}
            </Choice>
            <Choice
              action={rows.length > 1 ? `Keep mine in row ${letter(i)}` : "Use my version"}
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ action: "useMine", rowId: row.rowId })}
            >
              Mayfly changes {rows.length > 1 ? `row ${letter(i)}` : "the row"} in Maytas to match your entry, then reads it back.
              {extra}
            </Choice>
          </Fragment>
        ))}
        <Choice action="Forget this entry" danger disabled={resolve.isPending} onClick={() => resolve.mutate({ action: "forget" })}>
          Mayfly deletes the entry here only. Nothing is sent to Maytas, and {rows.length > 0 ? "the rows there stay" : "Maytas stays"} as it is.
        </Choice>
      </div>
      <div className="mt-2">
        <Problem error={resolve.error} />
      </div>
    </article>
  );
}

function Choice({ action, danger, disabled, onClick, children }: { action: string; danger?: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <button type="button" className={`btn shrink-0 sm:w-48 ${danger ? "btn-danger" : ""}`} disabled={disabled} onClick={onClick}>
        {action}
      </button>
      <p className="text-sm">{children}</p>
    </div>
  );
}

const fields: { label: string; value: (e: Row | Entry) => string }[] = [
  { label: "Date", value: (e) => formatDate(e.date) },
  { label: "Hours", value: (e) => `${formatHours(e.centihours)} h` },
  { label: "Where", value: (e) => e.where },
  { label: "Method", value: (e) => e.method },
  { label: "What you did", value: (e) => e.describe },
  { label: "What you learned", value: (e) => e.reflect },
  { label: "Anything else", value: (e) => e.anythingElse ?? "" },
  { label: "KSBs", value: (e) => [...e.ksbs].sort().join(", ") },
];

const norm = (text: string) => text.trim().replace(/\s+/g, " ");

/** Your entry next to the Maytas rows. Cells that differ from yours are marked. */
function Compare({ entry, rows }: { entry: Entry; rows: Row[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-mid">Maytas has no row for this entry now.</p>;
  }
  const differs = (f: (typeof fields)[number], r: Row) => norm(f.value(r)) !== norm(f.value(entry));
  const rowName = (i: number) => (rows.length > 1 ? `Maytas row ${String.fromCharCode(65 + i)}` : "In Maytas");
  return (
    <>
      <dl className="rows mt-3 border-y border-line text-sm sm:hidden">
        {fields.map((f) => (
          <div key={f.label} className="py-1.5">
            <dt className="font-semibold text-mid">{f.label}</dt>
            <dd className="whitespace-pre-wrap">
              <span className="text-mid">Yours: </span>
              {f.value(entry) || "–"}
            </dd>
            {rows.map((r, i) => (
              <dd key={r.rowId} className={`whitespace-pre-wrap ${differs(f, r) ? "bg-amber-soft" : ""}`}>
                <span className="text-mid">{rowName(i)}: </span>
                {f.value(r) || "–"}
                {differs(f, r) && <span className="sr-only"> (differs)</span>}
              </dd>
            ))}
          </div>
        ))}
      </dl>
    <div className="relative mt-3 hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-ink text-left">
            <th className="w-32 py-1.5 pr-3" />
            <th className="py-1.5 pr-3">Your entry in Mayfly</th>
            {rows.map((r, i) => (
              <th key={r.rowId} className="py-1.5 pr-3">
                {rowName(i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.label} className="border-b border-line align-top">
              <th scope="row" className="py-1.5 pr-3 text-left font-semibold text-mid">
                {f.label}
              </th>
              <td className="py-1.5 pr-3 whitespace-pre-wrap">{f.value(entry)}</td>
              {rows.map((r) => {
                const changed = differs(f, r);
                return (
                  <td key={r.rowId} className={`py-1.5 pr-3 whitespace-pre-wrap ${changed ? "bg-amber-soft" : ""}`}>
                    {f.value(r)}
                    {changed && <span className="sr-only"> (differs)</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
      <p className="hint mt-1">Shaded values differ from your entry.</p>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ChangeEvent, useMemo, useState } from "react";
import type { EntryFields } from "../../shared/entry";
import { api } from "../api";
import { checkValues, type FormValues } from "../entry-form";
import { errorText, firstLine, formatDate, type Profile, refreshEntries, refusalText, stateQuery, type SyncState, unwrap, warningText } from "../lib";
import { NoProfile, PageHead, Problem, SyncChip } from "../ui";

export const Route = createFileRoute("/add-many")({
  component: AddMany,
});

/** Splits CSV or tab-separated text into rows of cells. Handles quoted cells. */
function parseTable(text: string) {
  const delimiter = text.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

type Target = keyof FormValues;

const targets: { key: Target; label: string; required: boolean; guess: RegExp }[] = [
  { key: "date", label: "Date", required: true, guess: /date|day/i },
  { key: "hours", label: "Hours", required: true, guess: /hour|duration|time spent/i },
  { key: "where", label: "Where", required: true, guess: /where|location|place/i },
  { key: "method", label: "Method", required: true, guess: /method|type|activity/i },
  { key: "describe", label: "What you did", required: true, guess: /describe|description|what did you do|did|summary/i },
  { key: "reflect", label: "What you learned", required: true, guess: /reflect|learn/i },
  { key: "startTime", label: "Start time", required: false, guess: /start/i },
  { key: "anythingElse", label: "Anything else", required: false, guess: /anything|notes?|other/i },
  { key: "ksbs", label: "KSBs", required: false, guess: /ksb/i },
];

type Mapping = Partial<Record<Target, number>>;

function guessMapping(header: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const t of targets) {
    const index = header.findIndex((h, i) => !used.has(i) && t.guess.test(h));
    if (index >= 0) {
      mapping[t.key] = index;
      used.add(index);
    }
  }
  return mapping;
}

/** Accepts 2026-11-03, 03/11/2026 and 3/11/26 (day first, as in the UK). */
function normaliseDate(text: string) {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m) return t;
  const year = m[3]?.length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2]?.padStart(2, "0")}-${m[1]?.padStart(2, "0")}`;
}

const pickFrom = (list: string[], text: string) => list.find((x) => x.toLowerCase() === text.trim().toLowerCase()) ?? text.trim();

function toValues(cells: string[], mapping: Mapping, profile: Profile): FormValues {
  const cell = (key: Target) => {
    const index = mapping[key];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const codes = new Map(profile.ksbs.map((k) => [k.code.toLowerCase(), k.code]));
  return {
    date: normaliseDate(cell("date")),
    hours: cell("hours"),
    where: pickFrom(profile.wheres, cell("where")),
    method: pickFrom(profile.methods, cell("method")),
    describe: cell("describe"),
    reflect: cell("reflect"),
    startTime: cell("startTime").replace(/^(\d):/, "0$1:"),
    anythingElse: cell("anythingElse"),
    ksbs: cell("ksbs")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((k) => codes.get(k.toLowerCase()) ?? k),
  };
}

type RowResult = { kind: "saved" | "exists"; entryId: string; sync: SyncState; warnings: string[] } | { kind: "refused"; text: string };

function AddMany() {
  const qc = useQueryClient();
  const profile = useQuery(stateQuery).data?.profile;
  const [text, setText] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [results, setResults] = useState<Map<number, RowResult> | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const table = useMemo(() => parseTable(text), [text]);
  const header = hasHeader ? (table[0] ?? []) : [];
  const body = hasHeader ? table.slice(1) : table;
  const columns = Math.max(0, ...table.map((r) => r.length));
  const columnName = (i: number) => (hasHeader && header[i]?.trim() ? header[i].trim() : `Column ${i + 1}`);
  const map = mapping ?? guessMapping(header);

  const checked = profile ? body.map((cells) => checkValues(toValues(cells, map, profile), profile)) : [];
  const valid = checked.flatMap((c, i) => (c.fields ? [{ index: i, fields: c.fields }] : []));

  const save = useMutation({
    mutationFn: async (rows: { index: number; fields: EntryFields }[]) => {
      const out = new Map<number, RowResult>();
      for (let start = 0; start < rows.length; start += 1000) {
        const chunk = rows.slice(start, start + 1000);
        const { results } = await unwrap(api.api.entries.$post({ json: { entries: chunk.map((r) => r.fields) } }));
        results.forEach((r, i) => {
          const index = chunk[i]?.index;
          if (index === undefined) return;
          out.set(
            index,
            r.ok
              ? { kind: r.value.created ? "saved" : "exists", entryId: r.value.entry.id, sync: r.value.entry.sync, warnings: r.value.warnings }
              : { kind: "refused", text: refusalText(r) },
          );
        });
      }
      return out;
    },
    onSuccess: setResults,
    onSettled: () => refreshEntries(qc),
  });

  function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((content) => {
        setText(content);
        setMapping(null);
        setResults(null);
        setFileError(null);
      })
      .catch((error: unknown) => setFileError(`Mayfly could not read the file: ${errorText(error)}`));
  }

  if (!profile) return <NoProfile title="Add many" />;
  const savedCount = results ? [...results.values()].filter((r) => r.kind === "saved").length : 0;

  return (
    <div className="max-w-5xl">
      <PageHead title="Add many" />
      <p className="-mt-2 mb-4 max-w-prose text-mid">
        Paste rows from a spreadsheet, or load a CSV file. Then match the columns, check the rows, and save. Mayfly skips rows that it already has.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label className="label" htmlFor="paste">
            Rows
          </label>
          <textarea
            id="paste"
            className="input font-mono text-xs"
            rows={6}
            placeholder={"Date\tHours\tWhere\tMethod\tWhat did you do?\tWhat did you learn?\n03/11/2026\t2\tWorkplace\tResearch\t…\t…"}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResults(null);
            }}
          />
        </div>
        <div className="sm:pt-6">
          <label className="btn cursor-pointer">
            Load CSV file
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="sr-only" onChange={load} />
          </label>
        </div>
      </div>
      {fileError && <p className="error">{fileError}</p>}

      {table.length > 0 && (
        <>
          <section className="mt-6">
            <h2>Match the columns</h2>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-river"
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked);
                  setMapping(null);
                }}
              />
              The first row has the column names
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {targets.map((t) => (
                <div key={t.key}>
                  <label className="label" htmlFor={`map-${t.key}`}>
                    {t.label} {t.required ? <span className="req">(required)</span> : <span className="req">(optional)</span>}
                  </label>
                  <select
                    id={`map-${t.key}`}
                    className="input"
                    value={map[t.key] ?? ""}
                    onChange={(e) => setMapping({ ...map, [t.key]: e.target.value === "" ? undefined : Number(e.target.value) })}
                  >
                    <option value="">Not in the file</option>
                    {Array.from({ length: columns }, (_, i) => (
                      <option key={i} value={i}>
                        {columnName(i)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <p className="hint mt-2">Dates can be 2026-11-03 or 03/11/2026. KSBs can be codes split by spaces or commas.</p>
          </section>

          <section className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2>
                {body.length} {body.length === 1 ? "row" : "rows"}, {valid.length} ready to save
              </h2>
              <button
                type="button"
                className="btn btn-primary"
                disabled={valid.length === 0 || save.isPending || results !== null}
                onClick={() => save.mutate(valid)}
              >
                {save.isPending ? "Saving…" : `Save ${valid.length === 1 ? "1 entry" : `${valid.length} entries`}`}
              </button>
            </div>
            {results && (
              <p className="mt-2" aria-live="polite">
                <strong>
                  Saved {savedCount === 1 ? "1 entry" : `${savedCount} entries`}.
                </strong>{" "}
                They go to Maytas in the background. <Link to="/entries">See all entries</Link>
              </p>
            )}
            <Problem error={save.error} />
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b-2 border-ink text-left">
                    <th className="py-1.5 pr-3">Row</th>
                    <th className="py-1.5 pr-3">Date</th>
                    <th className="py-1.5 pr-3">Hours</th>
                    <th className="py-1.5 pr-3">Method</th>
                    <th className="py-1.5 pr-3">What you did</th>
                    <th className="py-1.5">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {body.map((cells, i) => {
                    const v = toValues(cells, map, profile);
                    const check = checked[i];
                    const result = results?.get(i);
                    return (
                      <tr key={i} className="border-b border-line align-top">
                        <td className="py-1.5 pr-3 text-mid tabular-nums">{i + 1}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{/^\d{4}-\d{2}-\d{2}$/.test(v.date) ? formatDate(v.date) : v.date}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{v.hours}</td>
                        <td className="py-1.5 pr-3">{v.method}</td>
                        <td className="max-w-64 truncate py-1.5 pr-3">{firstLine(v.describe)}</td>
                        <td className="py-1.5">
                          <RowStatus errors={check?.errors ?? {}} result={result} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function RowStatus({ errors, result }: { errors: Partial<Record<Target, string>>; result: RowResult | undefined }) {
  const problems = targets.flatMap((t) => (errors[t.key] ? [`${t.label}: ${errors[t.key]}`] : []));
  if (result?.kind === "refused") return <span className="text-rose">{result.text}</span>;
  if (result) {
    return (
      <span className="flex flex-col items-start gap-1">
        <span className="flex items-center gap-2">
          <SyncChip sync={result.sync} />
          <Link to="/entries/$id" params={{ id: result.entryId }}>
            {result.kind === "saved" ? "Saved" : "Already in Mayfly"}
          </Link>
        </span>
        {result.warnings.map((w) => (
          <span key={w} className="text-amber">
            {warningText(w).text}
          </span>
        ))}
      </span>
    );
  }
  if (problems.length === 0) return <span className="text-river">Ready</span>;
  return (
    <ul className="text-rose">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

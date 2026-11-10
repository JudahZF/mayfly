import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import {
  formatDate,
  formatHours,
  formDeadline,
  type NextReview,
  refreshEntries,
  type Review,
  type ReviewsData,
  reviewsQuery,
  stateQuery,
  todayIso,
  unwrap,
  useRefreshMs,
} from "../lib";
import { PageHead, Problem, useResume } from "../ui";

export const Route = createFileRoute("/reviews")({
  component: Reviews,
});

/** Pauses sync, then opens a Maytas page in a new tab. Maytas allows one session, so Mayfly must not sign in meanwhile. */
function useOpenInMaytas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => {
      // Open the tab inside the click, or the browser blocks it; point it at Maytas once sync is paused.
      const tab = window.open("", "_blank");
      try {
        await unwrap(api.api.settings.$patch({ json: { syncPaused: true } }));
      } catch (error) {
        tab?.close();
        throw error;
      }
      if (!tab) return window.location.assign(url);
      tab.opener = null;
      tab.location.href = url;
    },
    onSettled: () => refreshEntries(qc),
  });
}

function Reviews() {
  const reviews = useQuery({ ...reviewsQuery, refetchInterval: useRefreshMs() });
  const open = useOpenInMaytas();
  if (!reviews.data) return <Problem error={reviews.error} />;
  const { prep } = reviews.data;
  const today = todayIso();
  const past = reviews.data.reviews
    .filter((r) => r.visitId !== prep.next?.visitId && (r.actualDate !== null || r.plannedDate < today))
    .sort((a, b) => (b.actualDate ?? b.plannedDate).localeCompare(a.actualDate ?? a.plannedDate));

  return (
    <div className="max-w-4xl space-y-8">
      <PageHead title="Reviews" />
      {prep.next ? (
        <NextCard next={prep.next} open={(url) => open.mutate(url)} opening={open.isPending} />
      ) : (
        <p className="panel px-4 py-3">
          {reviews.data.reviews.length === 0
            ? "Mayfly has not read your reviews from Maytas yet. It reads them at each sync."
            : "Maytas has no review planned for you yet."}
        </p>
      )}
      <Problem error={open.error} />
      <Prep data={reviews.data} />
      <Past reviews={past} open={(url) => open.mutate(url)} opening={open.isPending} />
    </div>
  );
}

function NextCard({ next, open, opening }: { next: NextReview; open: (url: string) => void; opening: boolean }) {
  const state = useQuery(stateQuery);
  const resume = useResume();
  const deadline = formDeadline(next);
  return (
    <section aria-labelledby="next-title" className="panel px-4 py-4">
      <h2 id="next-title" className="font-sans text-sm font-semibold text-mid">
        Next review
      </h2>
      <p className="mt-1 font-serif text-4xl leading-none font-semibold">{formatDate(next.plannedDate)}</p>
      <p className="mt-2">
        {next.type}
        {next.staff && <> with {next.staff}</>}
      </p>
      <p className="mt-1 text-sm">
        <span className="text-mid">{next.form ? `${next.form.name} form: ` : "Form: "}</span>
        <strong>{next.form ? next.form.status : "not in Maytas yet"}</strong>
      </p>
      <p
        role={deadline.urgent ? "alert" : undefined}
        className={`mt-3 rounded-lg px-3 py-2 ${deadline.urgent ? "border border-rose bg-rose-soft font-semibold text-rose" : "bg-code"}`}
      >
        {deadline.text}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" className="btn btn-primary" disabled={opening} onClick={() => open(next.form?.url ?? next.url)}>
          {next.form ? "Open the form in Maytas" : "Open the review in Maytas"}
        </button>
        <span className="hint">Maytas allows one session at a time, so this pauses sync first.</span>
      </div>
      {state.data?.settings.syncPaused && (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <strong>Sync is paused.</strong> Turn it back on when you finish in Maytas.
          <button type="button" className="btn btn-small" disabled={resume.isPending} onClick={() => resume.mutate(state.data)}>
            Resume sync
          </button>
        </p>
      )}
      <Problem error={resume.error} />
    </section>
  );
}

function Prep({ data }: { data: ReviewsData }) {
  const { since, last, progress } = data.prep;
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(data.summary);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    setTimeout(() => setCopy("idle"), 2500);
  }

  const total = since.confirmedCentihours + since.pendingCentihours + since.needsYouCentihours;
  return (
    <section aria-labelledby="prep-title">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-1">
        <h2 id="prep-title">{last ? "Since your last review" : "All your entries"}</h2>
        <button type="button" className="btn btn-small" onClick={copySummary}>
          {copy === "copied" ? "Copied" : "Copy summary"}
        </button>
      </div>
      <p className="hint mt-1.5">
        {last ? `Entries after your review on ${formatDate(last.actualDate)}. ` : "Maytas has no completed review yet. "}
        Drafts do not count. Copy the summary to keep the facts beside you while you fill in the form.
      </p>
      {copy === "failed" && <Problem error={new Error("The browser did not allow the copy. Select the text below and copy it yourself.")} />}

      <p className="mt-3 text-lg">
        <strong className="tabular-nums">{formatHours(total)} h</strong> in {since.entryCount === 1 ? "1 entry" : `${since.entryCount} entries`}
      </p>
      <p className="hint">
        {formatHours(since.confirmedCentihours)} h in Maytas
        {since.pendingCentihours > 0 && `, ${formatHours(since.pendingCentihours)} h on the way`}
        {since.needsYouCentihours > 0 && `, ${formatHours(since.needsYouCentihours)} h that need you`}.
        {progress.targetCentihours !== null &&
          ` Overall: ${formatHours(progress.confirmedCentihours)} of ${formatHours(progress.targetCentihours)} h in Maytas.`}
      </p>

      <div className="mt-6 grid gap-8 md:grid-cols-2">
        <div>
          <h3 className="font-semibold">Hours per method</h3>
          {since.methods.length === 0 ? (
            <p className="hint mt-1">No entries.</p>
          ) : (
            <ul className="rows mt-1.5 border-y border-line text-sm">
              {since.methods.map((m) => (
                <li key={m.method} className="flex justify-between gap-3 py-1.5">
                  <span>{m.method}</span>
                  <span className="shrink-0 tabular-nums">
                    <strong>{formatHours(m.centihours)} h</strong>{" "}
                    <span className="text-mid">in {m.entries === 1 ? "1 entry" : `${m.entries} entries`}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="font-semibold">KSBs with no evidence</h3>
          {since.ksbsWithoutEvidence.length === 0 ? (
            <p className="hint mt-1">Every KSB has evidence.</p>
          ) : (
            <ul className="rows mt-1.5 border-y border-line text-sm">
              {since.ksbsWithoutEvidence.map((k) => (
                <li key={k.code} className="grid grid-cols-[2.5rem_1fr] gap-x-2 py-1.5">
                  <span className="font-semibold text-rose">{k.code}</span>
                  <span>{k.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h3 className="mt-6 font-semibold">KSB evidence</h3>
      {since.ksbs.length === 0 ? (
        <p className="hint mt-1">No KSB has evidence yet.</p>
      ) : (
        <ul className="rows mt-1.5 border-y border-line text-sm">
          {since.ksbs.map((k) => (
            <li key={k.code} className="grid grid-cols-[2.5rem_1fr_auto] gap-x-3 py-1.5">
              <span className="font-semibold">{k.code}</span>
              <span>{k.text}</span>
              <span className="tabular-nums">
                <strong>{formatHours(k.centihours)} h</strong>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 font-semibold">Entries</h3>
      {since.entries.length === 0 ? (
        <p className="hint mt-1">
          No entries yet. <Link to="/log">Log hours</Link>
        </p>
      ) : (
        <ol className="rows mt-1.5 border-y border-line">
          {since.entries.map((e) => (
            <li key={e.id}>
              <Link to="/entries/$id" params={{ id: e.id }} className="block px-1 py-2.5 text-ink no-underline hover:bg-code">
                <span className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="text-mid">{formatDate(e.date)}</span>
                  <strong className="tabular-nums">{formatHours(e.centihours)} h</strong>
                  <span className="text-mid">{e.method}</span>
                  {e.ksbs.length > 0 && <span className="font-mono text-xs text-mid">{e.ksbs.join(" ")}</span>}
                </span>
                <span className="mt-1 block">{e.describe}</span>
                <span className="mt-0.5 block text-sm text-mid">{e.reflect}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Past({ reviews, open, opening }: { reviews: Review[]; open: (url: string) => void; opening: boolean }) {
  if (reviews.length === 0) return null;
  return (
    <section aria-labelledby="past-title">
      <h2 id="past-title" className="border-b-2 border-ink pb-1">
        Past reviews
      </h2>
      <p className="hint mt-1.5">Maytas keeps each completed review as a PDF. Opening Maytas pauses sync.</p>
      <ul className="rows mt-1.5 border-b border-line">
        {reviews.map((r) => (
          <li key={r.visitId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
            <span className="w-full font-semibold sm:w-28 sm:shrink-0">{formatDate(r.actualDate ?? r.plannedDate)}</span>
            <span className="min-w-0 flex-1 text-sm">
              {r.type}
              {r.staff && <span className="text-mid"> with {r.staff}</span>}
              <span className="block text-mid">{r.outcome ?? (r.actualDate ? "No outcome recorded" : "No actual date in Maytas")}</span>
            </span>
            <button type="button" className="btn btn-small" disabled={opening} onClick={() => open(r.url)}>
              Open in Maytas
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

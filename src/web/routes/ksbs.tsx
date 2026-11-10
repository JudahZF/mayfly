import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatHours, ksbsQuery, stateQuery } from "../lib";
import { PageHead, Problem } from "../ui";

export const Route = createFileRoute("/ksbs")({
  component: Ksbs,
});

const groups = [
  { prefix: "K", title: "Knowledge" },
  { prefix: "S", title: "Skills" },
  { prefix: "B", title: "Behaviours" },
] as const;

function Ksbs() {
  const ksbs = useQuery(ksbsQuery);
  const standard = useQuery(stateQuery).data?.progress.standard;
  const list = ksbs.data ?? [];
  const top = Math.max(100, ...list.map((k) => k.centihours));
  const empty = list.filter((k) => k.entries === 0).length;

  return (
    <div className="max-w-3xl">
      <PageHead title="KSBs" />
      <p className="-mt-2 mb-5 text-mid">
        {standard ? `${standard}. ` : ""}Hours of evidence for each knowledge, skill and behaviour. Drafts do not count.
        {list.length > 0 && (empty === 0 ? " Every KSB has evidence." : ` ${empty} of ${list.length} have no evidence yet.`)}
      </p>
      <Problem error={ksbs.error} />
      {!ksbs.isPending && list.length === 0 && <p>Mayfly has not read the KSB list from Maytas yet. It does this at the first sync.</p>}
      <div className="space-y-6">
        {groups.map((g) => {
          const items = list.filter((k) => k.code.startsWith(g.prefix));
          const rest = g.prefix === "B" ? list.filter((k) => !groups.some((x) => k.code.startsWith(x.prefix))) : [];
          if (items.length + rest.length === 0) return null;
          return (
            <section key={g.prefix}>
              <h2 className="border-b-2 border-ink pb-1">{g.title}</h2>
              <ul className="rows">
                {[...items, ...rest].map((k) => (
                  <li key={k.code} className="grid grid-cols-[3rem_1fr] gap-x-3 py-2.5 sm:grid-cols-[3rem_1fr_12rem]">
                    <span className="font-serif text-lg font-semibold">{k.code}</span>
                    <span className="text-sm">{k.text}</span>
                    <span className="col-start-2 mt-1.5 sm:col-start-3 sm:mt-0">
                      {k.entries === 0 ? (
                        <span className="text-sm font-semibold text-rose">No evidence</span>
                      ) : (
                        <>
                          <span className="block text-sm tabular-nums">
                            <strong>{formatHours(k.centihours)} h</strong>{" "}
                            <span className="text-mid">in {k.entries === 1 ? "1 entry" : `${k.entries} entries`}</span>
                          </span>
                          <span className="mt-1 block h-1.5 rounded-full bg-code">
                            <span className="block h-full rounded-full bg-river" style={{ width: `${(k.centihours / top) * 100}%` }} />
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

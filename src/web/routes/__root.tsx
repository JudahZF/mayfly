import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { type AppState, stateQuery, Unauthorized } from "../lib";
import { BridgeStatus, Problem } from "../ui";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
});

type NavItem = { to: "/" | "/log" | "/entries" | "/needs-you" | "/reviews" | "/add-many" | "/ksbs" | "/sync" | "/settings"; label: string };

const mainNav: NavItem[] = [
  { to: "/", label: "Home" },
  { to: "/log", label: "Log hours" },
  { to: "/entries", label: "Entries" },
  { to: "/needs-you", label: "Needs you" },
  { to: "/reviews", label: "Reviews" },
];
const moreNav: NavItem[] = [
  { to: "/add-many", label: "Add many" },
  { to: "/ksbs", label: "KSBs" },
  { to: "/sync", label: "Sync" },
  { to: "/settings", label: "Settings" },
];

function Root() {
  const state = useQuery(stateQuery);
  if (state.error instanceof Unauthorized) return <TokenPrompt />;
  return (
    <div className="mx-auto min-h-dvh max-w-6xl sm:grid sm:grid-cols-[13rem_1fr]">
      <Sidebar state={state.data} />
      <MobileTop state={state.data} />
      <main className="min-w-0 px-4 pt-4 pb-24 sm:px-8 sm:pt-7 sm:pb-12">
        <Outlet />
      </main>
      <TabBar state={state.data} />
    </div>
  );
}

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return <span className="ml-auto rounded-full bg-rose px-1.5 text-xs font-bold leading-5 text-paper tabular-nums">{n}</span>;
}

const needsYouCount = (state: AppState | undefined) => state?.bridge.counts.needsYou ?? 0;

function Sidebar({ state }: { state: AppState | undefined }) {
  const link = (item: NavItem) => (
    <li key={item.to}>
      <Link
        to={item.to}
        activeOptions={{ exact: item.to === "/" }}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-ink no-underline hover:bg-code data-[status=active]:bg-river-soft data-[status=active]:font-semibold data-[status=active]:text-river"
      >
        {item.label}
        {item.to === "/needs-you" && <Count n={needsYouCount(state)} />}
      </Link>
    </li>
  );
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line px-3 py-7 sm:flex">
      <Link to="/" className="px-2.5 font-serif text-2xl font-semibold text-ink no-underline">
        Mayfly
      </Link>
      <nav aria-label="Main">
        <ul className="space-y-0.5">{mainNav.map(link)}</ul>
        <ul className="mt-4 space-y-0.5 border-t border-line pt-4">{moreNav.map(link)}</ul>
      </nav>
      {state && (
        <Link to="/sync" className="mt-auto px-2.5 text-ink no-underline" aria-label="Sync status">
          <BridgeStatus state={state} compact />
          {state.settings.agentMode === "fullAccess" && <p className="mt-2 text-sm font-semibold text-rose">Agents have full access</p>}
        </Link>
      )}
    </aside>
  );
}

function MobileTop({ state }: { state: AppState | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 sm:hidden">
      <Link to="/" className="font-serif text-xl font-semibold text-ink no-underline">
        Mayfly
      </Link>
      {state && (
        <Link to="/sync" className="no-underline" aria-label="Sync status">
          <BridgeStatus state={state} compact />
        </Link>
      )}
    </div>
  );
}

/** Phone navigation, in reach of the thumb. "Log hours" sits in the middle. */
function TabBar({ state }: { state: AppState | undefined }) {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);
  const tab = "flex min-h-14 flex-1 flex-col whitespace-nowrap items-center justify-center gap-0.5 text-xs font-semibold text-mid no-underline data-[status=active]:text-river";
  const items: NavItem[] = [mainNav[0], mainNav[2], mainNav[1], mainNav[3]].filter((i) => i !== undefined);
  const more = [...mainNav.filter((i) => !items.includes(i)), ...moreNav];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-raised pb-[env(safe-area-inset-bottom)] sm:hidden">
      {open && (
        <ul className="rows border-b border-line">
          {more.map((item) => (
            <li key={item.to}>
              <Link to={item.to} className="block px-5 py-3 text-ink no-underline data-[status=active]:font-semibold data-[status=active]:text-river">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex">
        {items.map((item) =>
          item.to === "/log" ? (
            <Link key={item.to} to={item.to} className="flex flex-[1.4] items-center justify-center px-1 no-underline">
              <span className="btn btn-primary w-full">Log hours</span>
            </Link>
          ) : (
            <Link key={item.to} to={item.to} activeOptions={{ exact: item.to === "/" }} className={tab}>
              <span className="flex items-center gap-1">
                {item.label}
                {item.to === "/needs-you" && <Count n={needsYouCount(state)} />}
              </span>
            </Link>
          ),
        )}
        <button type="button" className={tab} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          More
        </button>
      </div>
    </nav>
  );
}

function TokenPrompt() {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const session = useMutation({
    mutationFn: async (value: string) => {
      const res = await api.api.session.$post({ json: { token: value } });
      if (res.status === 401) throw new Error("That token is wrong. Copy it again from MAYFLY_TOKEN in the .env file.");
      if (!res.ok) throw new Error(`Mayfly could not check the token (error ${res.status}). Try again.`);
    },
    onSuccess: () => qc.invalidateQueries(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim() !== "") session.mutate(token.trim());
  };
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1>Mayfly</h1>
      <p className="mt-3">This copy of Mayfly is protected. Enter its access token to continue.</p>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <div>
          <label className="label" htmlFor="token">
            Access token
          </label>
          <input id="token" type="password" autoComplete="current-password" className="input" value={token} onChange={(e) => setToken(e.target.value)} />
          <p className="hint mt-1">It is the MAYFLY_TOKEN value in the .env file of the machine that runs Mayfly.</p>
        </div>
        <Problem error={session.error} />
        <button type="submit" className="btn btn-primary w-full" disabled={session.isPending}>
          Unlock Mayfly
        </button>
      </form>
    </main>
  );
}

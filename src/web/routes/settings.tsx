import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { AgentMode } from "../../shared/entry";
import { api } from "../api";
import { stateQuery, unwrap } from "../lib";
import { PageHead, Problem } from "../ui";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

const modes: { value: AgentMode; label: string; text: string }[] = [
  {
    value: "drafts",
    label: "Drafts",
    text: "Agents can read your entries and progress, and add drafts. A draft goes to Maytas only after you approve it. Agents can change or delete drafts only.",
  },
  {
    value: "fullAccess",
    label: "Full access",
    text: "Agents can do what you can do in Mayfly: add entries that go straight to Maytas, approve drafts, and change or delete entries that are in Maytas. They cannot change this setting, see your Maytas password, or sign a review.",
  },
];

function Settings() {
  const qc = useQueryClient();
  const state = useQuery(stateQuery);
  const [copied, setCopied] = useState(false);
  const setMode = useMutation({
    mutationFn: (agentMode: AgentMode) => unwrap(api.api.settings.$patch({ json: { agentMode } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["state"] }),
  });
  const mcpUrl = `${window.location.origin}/mcp`;
  const mode = setMode.isPending ? setMode.variables : state.data?.settings.agentMode;

  async function copy() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <PageHead title="Settings" />
      <Problem error={state.error} />

      <fieldset>
        <legend className="font-serif text-lg font-semibold">Agent mode</legend>
        <p className="hint mb-3">What an agent such as Claude can do through MCP. Agents never talk to Maytas directly.</p>
        <div className="space-y-2">
          {modes.map((m) => (
            <label
              key={m.value}
              className={`panel flex cursor-pointer gap-3 px-3 py-3 ${mode === m.value ? (m.value === "fullAccess" ? "border-rose" : "border-river") : ""}`}
            >
              <input
                type="radio"
                name="agentMode"
                className="mt-1 size-4 accent-river"
                checked={mode === m.value}
                disabled={!state.data}
                onChange={() => setMode.mutate(m.value)}
              />
              <span>
                <strong className={m.value === "fullAccess" ? "text-rose" : undefined}>{m.label}</strong>
                <span className="mt-0.5 block text-sm">{m.text}</span>
              </span>
            </label>
          ))}
        </div>
        <Problem error={setMode.error} />
      </fieldset>

      <section>
        <h2>Connect an agent</h2>
        <p className="mt-1 text-sm">Add this address as an MCP server (HTTP) in Claude Code or T3 Code.</p>
        <div className="mt-2 flex gap-2">
          <label htmlFor="mcp" className="sr-only">
            MCP address
          </label>
          <input id="mcp" readOnly className="input font-mono text-sm" value={mcpUrl} onFocus={(e) => e.target.select()} />
          <button type="button" className="btn shrink-0" onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
        <p className="hint mt-1">An agent on another machine also needs the access token, sent as a Bearer token.</p>
      </section>

      <section>
        <h2>Export</h2>
        <p className="mt-1 text-sm">All your entries as a CSV file, deleted ones included.</p>
        <a className="btn mt-2" href="/api/export.csv" download>
          Download CSV
        </a>
      </section>
    </div>
  );
}

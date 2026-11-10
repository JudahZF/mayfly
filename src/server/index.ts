import { serveStatic } from "@hono/bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeMaytas, sampleRows } from "../maytas/fake";
import { createHttpMaytas } from "../maytas/http";
import type { Maytas, MaytasRow } from "../maytas/types";
import { createMayfly } from "./api";
import { openDb } from "./db";
import { env } from "./env";

mkdirSync(env.MAYFLY_DATA_DIR, { recursive: true });
const db = openDb(join(env.MAYFLY_DATA_DIR, "mayfly.db"));

/** The fake keeps its rows in the data folder, so a restart does not look like rows vanished from Maytas. */
async function fakeMaytas() {
  const file = Bun.file(join(env.MAYFLY_DATA_DIR, "fake-maytas.json"));
  const saved: MaytasRow[] | null = (await file.exists()) ? await file.json() : null;
  return new FakeMaytas({
    ...(saved ? { saved } : { rows: sampleRows }),
    onChange: (rows) => void Bun.write(file, JSON.stringify(rows, null, 2)),
  });
}

const maytas: Maytas =
  env.MAYTAS_MODE === "fake"
    ? await fakeMaytas()
    : createHttpMaytas({ url: env.MAYTAS_URL, username: env.MAYTAS_USERNAME ?? "", password: env.MAYTAS_PASSWORD ?? "" });

const { app, bridge } = createMayfly({
  db,
  maytas,
  token: env.MAYFLY_TOKEN,
  bridgeConfig: env.MAYTAS_MODE === "fake" ? { requestGapMs: 200, checkGapMs: 500 } : {},
});

const webRoot = join(import.meta.dir, "../../dist/web");
app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ root: webRoot, path: "index.html" }));

bridge.start();

const server = Bun.serve({ hostname: env.MAYFLY_HOST, port: env.MAYFLY_PORT, fetch: app.fetch });
console.log(`Mayfly on ${server.url} (Maytas: ${env.MAYTAS_MODE})`);

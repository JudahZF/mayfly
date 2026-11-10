import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** Opens (or creates) the store and applies pending migrations. Pass ":memory:" for tests. */
export function openDb(path: string) {
  const client = new Database(path, { create: true, strict: true });
  client.run("pragma journal_mode = wal");
  client.run("pragma foreign_keys = on");
  const db = drizzle({ client, schema, casing: "snake_case" });
  migrate(db, { migrationsFolder });
  db.insert(schema.settings).values({ id: 1 }).onConflictDoNothing().run();
  return db;
}

export type Db = ReturnType<typeof openDb>;

export function readSettings(db: Db) {
  const row = db.select().from(schema.settings).where(eq(schema.settings.id, 1)).get();
  if (!row) throw new Error("The settings row is missing");
  return row;
}

export const writeSettings = (db: Db, patch: Partial<Omit<schema.Settings, "id">>) =>
  db.update(schema.settings).set(patch).where(eq(schema.settings.id, 1)).run();

export const readProfile = (db: Db) => db.select().from(schema.profile).where(eq(schema.profile.id, 1)).get()?.data ?? null;

export const readReviews = (db: Db) => db.select().from(schema.reviews).where(eq(schema.reviews.id, 1)).get()?.data ?? [];

export const writeLog = (db: Db, line: Omit<schema.LogEntry, "id">) => db.insert(schema.bridgeLog).values(line).run();

/**
 * DB accessor for the content selectors, with a test seam.
 *
 * Production resolves the shared libsql client via `ensureSchema()` (so the
 * catalog schema + selector indexes are guaranteed present). Tests inject a
 * fresh `:memory:` client with their own seed data via `__setSelectorDbForTests`
 * — mirroring database.ts's `__setInitSchemaImplForTests` seam — so selector SQL
 * can be exercised without a live Turso connection.
 */
import type { Client } from "@libsql/client";
import { ensureSchema } from "@/lib/database";

let injected: Client | null = null;

/** Resolve the client selectors should query. */
export async function getSelectorDb(): Promise<Client> {
  if (injected) return injected;
  return ensureSchema();
}

/** Test-only: force selectors to use `client` (pass null to restore prod). */
export function __setSelectorDbForTests(client: Client | null): void {
  injected = client;
}

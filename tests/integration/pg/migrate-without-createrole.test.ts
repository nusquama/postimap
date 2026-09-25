import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Kysely, sql } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connectPg, env } from "../../setup/e2e-helpers.js";

/**
 * A managed database gives the service a role without CREATEROLE, and an administrator
 * creates postimap_app beforehand. The migrations must run as that role.
 */
const role = `migrator_${randomUUID().slice(0, 8)}`;
const password = randomUUID();

beforeAll(async () => {
  const admin = connectPg();
  try {
    await admin.unsafe(`CREATE ROLE ${role} LOGIN NOCREATEROLE PASSWORD '${password}'`);
    await admin.unsafe(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`);
    // What an administrator does before the first start
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postimap_app') THEN
          CREATE ROLE postimap_app NOLOGIN;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public");
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  const admin = connectPg();
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${role} CASCADE`);
    await admin.unsafe(`DROP OWNED BY ${role}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await admin.end();
  }
});

describe("migrations as a role without CREATEROLE", () => {
  test("run to the latest version when postimap_app already exists", async () => {
    const url = `postgresql://${role}:${password}@${env.PG_HOST}:${env.PG_PORT}/${env.PG_DATABASE}?search_path=${role}`;
    const db = new Kysely<unknown>({ dialect: new PostgresJSDialect({ postgres: postgres(url) }) });
    try {
      const migrator = new Migrator({
        db,
        provider: new FileMigrationProvider({
          fs,
          path,
          migrationFolder: path.resolve(import.meta.dirname, "../../../src/db/migrations"),
        }),
        migrationTableSchema: role,
      });
      const { error, results } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      expect(results?.every((r) => r.status === "Success")).toBe(true);

      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = ${role} AND table_name = 'messages'
      `.execute(db);
      expect(rows[0].n).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});

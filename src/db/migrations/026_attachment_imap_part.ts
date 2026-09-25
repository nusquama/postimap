import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * The attachment's MIME part number on the server (BODYSTRUCTURE numbering, "2", "1.3").
 *
 * With storage.attachments = on_demand, attachment bytes stay on the server: the row keeps
 * `data` NULL and this part number, and the bytes are fetched from IMAP when asked for.
 * Rows stored with `data` leave it NULL. Covered by the table-level SELECT granted to
 * postimap_app in 005.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attachments ADD COLUMN imap_part TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE attachments DROP COLUMN imap_part`.execute(db);
}

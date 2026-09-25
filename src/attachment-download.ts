import type { Kysely } from "kysely";
import { decryptPassword } from "./crypto.js";
import type { Database } from "./db/schema.js";
import { ImapClient } from "./imap/pool.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("attachment-download");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttachmentDownloadConfig {
  encryptionKey?: string;
  tlsRejectUnauthorized: boolean;
}

export interface OpenedAttachment {
  filename: string | null;
  contentType: string;
  content: Buffer | NodeJS.ReadableStream;
  /** Releases the IMAP connection; call once the content has been consumed or abandoned. */
  done(): Promise<void>;
}

/**
 * An attachment's bytes: from PG when they were stored there, otherwise downloaded from
 * the server by UID and MIME part number (storage.attachments = on_demand), on a
 * connection of its own so the account's sync connection is never held up.
 *
 * Returns null when there is nothing to serve any more: unknown id, message expunged, or
 * the folder renumbered since the row was written. Throws on connection or server errors.
 */
export async function openAttachment(
  db: Kysely<Database>,
  attachmentId: string,
  config: AttachmentDownloadConfig,
): Promise<OpenedAttachment | null> {
  if (!UUID.test(attachmentId)) return null;

  const row = await db
    .selectFrom("attachments as a")
    .innerJoin("messages as m", "m.id", "a.message_id")
    .innerJoin("folders as f", "f.id", "m.folder_id")
    .innerJoin("accounts as acc", "acc.id", "m.account_id")
    .select([
      "a.filename",
      "a.content_type",
      "a.data",
      "a.imap_part",
      "m.imap_uid",
      "m.expunged_at",
      "f.imap_name",
      "f.uidvalidity",
      "acc.imap_host",
      "acc.imap_port",
      "acc.imap_user",
      "acc.imap_password",
    ])
    .where("a.id", "=", attachmentId)
    .executeTakeFirst();
  if (!row) return null;

  const contentType = row.content_type ?? "application/octet-stream";
  if (row.data) {
    return { filename: row.filename, contentType, content: row.data, done: async () => {} };
  }
  if (!row.imap_part || !row.imap_uid || row.expunged_at) return null;

  const client = new ImapClient({
    host: row.imap_host,
    port: row.imap_port,
    user: row.imap_user,
    password: decryptPassword(row.imap_password, config.encryptionKey),
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
    retry: { maxRetries: 0 },
  });
  await client.connect();

  let lock: { release(): void } | undefined;
  const done = async (): Promise<void> => {
    lock?.release();
    lock = undefined;
    await client.disconnect().catch(() => {});
  };

  try {
    lock = await client.client.getMailboxLock(row.imap_name, { readOnly: true });
    const mailbox = client.client.mailbox;
    // A renumbered folder: the stored UID may now name another message.
    if (!mailbox || (row.uidvalidity && String(mailbox.uidValidity) !== String(row.uidvalidity))) {
      await done();
      return null;
    }

    const { meta, content } = await client.client.download(row.imap_uid, row.imap_part, {
      uid: true,
    });
    // The part at that number must still be the attachment the row describes.
    if (meta.contentType && row.content_type && meta.contentType !== row.content_type) {
      log.warn(
        { attachmentId, expected: row.content_type, found: meta.contentType },
        "Attachment part no longer matches its row, refusing to serve it",
      );
      await done();
      return null;
    }
    return { filename: row.filename, contentType, content, done };
  } catch (err) {
    await done();
    throw err;
  }
}

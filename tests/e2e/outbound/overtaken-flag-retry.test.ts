import { describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  appendBulkMessages,
  connectImap,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

/**
 * A failed flag write waits for its backoff while a newer write to the same flag goes
 * through. When the old one's retry comes round, the consumer's last word must stand.
 */
describe("E2E: a retried flag write overtaken by a newer one", () => {
  test("is dropped instead of undoing the newer write on the server", async () => {
    const ctx = await setupE2EContext({ emailPrefix: "e2e-overtaken" });
    try {
      const other = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
      try {
        await appendBulkMessages(other, "INBOX", 1, []);
      } finally {
        await other.logout();
      }
      const inbound = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
      expect((await inbound.fullSync(ctx.folderId, "INBOX", true)).errors).toEqual([]);
      const [message] = await ctx.pgSql`
        SELECT id, imap_uid FROM messages WHERE folder_id = ${ctx.folderId}
      `;
      const uid = Number(message.imap_uid);

      const outbound = new OutboundProcessor(
        ctx.db,
        getDatabaseUrl(ctx.schema),
        () => ctx.imapClient,
        async () => testCapabilities,
        60_000,
        60_000,
        5,
      );

      // 1. Mark read. Its first attempt fails and backs off.
      await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${message.id}`;
      const [older] = await ctx.pgSql`
        SELECT id FROM sync_queue WHERE message_id = ${message.id} AND action = 'flag_add'
      `;
      await ctx.pgSql`
        UPDATE sync_queue
        SET status = 'failed', attempts = 1, error = 'simulated',
            next_retry_at = now() + interval '1 hour'
        WHERE id = ${older.id}
      `;

      // 2. Mark unread. Goes through while the read waits.
      await ctx.pgSql`UPDATE messages SET is_seen = false WHERE id = ${message.id}`;
      await outbound.drain(ctx.accountId);

      // 3. The read's backoff ends.
      await ctx.pgSql`UPDATE sync_queue SET next_retry_at = now() WHERE id = ${older.id}`;
      await outbound.drain(ctx.accountId);

      const [olderAfter] = await ctx.pgSql`SELECT status FROM sync_queue WHERE id = ${older.id}`;
      expect(olderAfter.status).toBe("completed");

      const check = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
      try {
        const lock = await check.getMailboxLock("INBOX");
        try {
          const msg = await check.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
          expect(msg === false ? null : msg.flags.has("\\Seen")).toBe(false);
        } finally {
          lock.release();
        }
      } finally {
        await check.logout();
      }
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 30_000);
});

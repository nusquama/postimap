import { describe, expect, test } from "vitest";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  appendBulkMessages,
  connectImap,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

/**
 * fullSync() is what every account start runs, so a folder renumbered while PostIMAP was
 * down is first seen there, not in syncFolder(). From PostIMAP's side a renumbering is a
 * stored UIDVALIDITY that no longer matches the server's; the test produces exactly that.
 */
describe("E2E: UIDVALIDITY changed while not syncing", () => {
  test("fullSync replaces the folder's rows and dead-letters its queued writes", async () => {
    const ctx = await setupE2EContext({ emailPrefix: "e2e-uidv-full" });
    try {
      const other = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
      try {
        await appendBulkMessages(other, "INBOX", 2, []);
      } finally {
        await other.logout();
      }

      const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, testCapabilities);
      expect((await sync.fullSync(ctx.folderId, "INBOX", true)).errors).toEqual([]);

      const before = await ctx.pgSql`
        SELECT id FROM messages WHERE folder_id = ${ctx.folderId} ORDER BY imap_uid
      `;
      expect(before).toHaveLength(2);

      // An app write captured under the old numbering, not yet sent to the server.
      await ctx.pgSql`UPDATE messages SET is_seen = true WHERE id = ${before[0].id}`;
      const [folder] = await ctx.pgSql`
        SELECT uidvalidity FROM folders WHERE id = ${ctx.folderId}
      `;
      const serverUidValidity = String(folder.uidvalidity);
      await ctx.pgSql`
        UPDATE folders SET uidvalidity = ${String(BigInt(serverUidValidity) + 1n)}
        WHERE id = ${ctx.folderId}
      `;

      const restart = await sync.fullSync(ctx.folderId, "INBOX", false);
      expect(restart.errors).toEqual([]);
      expect(restart.newMessages).toBe(2);

      const after = await ctx.pgSql`
        SELECT id FROM messages WHERE folder_id = ${ctx.folderId} AND expunged_at IS NULL
      `;
      expect(after).toHaveLength(2);
      const oldIds = new Set(before.map((r) => r.id));
      expect(after.some((r) => oldIds.has(r.id))).toBe(false);

      // setupE2EContext's own folder INSERT queues a folder_create; only the message write matters.
      const queued = await ctx.pgSql`
        SELECT status FROM sync_queue WHERE action = 'flag_add'
      `;
      expect(queued.map((r) => r.status)).toEqual(["dead"]);

      const [updated] = await ctx.pgSql`
        SELECT uidvalidity FROM folders WHERE id = ${ctx.folderId}
      `;
      expect(String(updated.uidvalidity)).toBe(serverUidValidity);
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 30_000);
});

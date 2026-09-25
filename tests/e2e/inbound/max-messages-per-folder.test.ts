import { describe, expect, test } from "vitest";
import { detectCapabilities } from "../../../src/imap/capabilities.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import {
  appendBulkMessages,
  connectImap,
  type E2EContext,
  env,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";

/** sync.max_messages_per_folder against a server without CONDSTORE (full-diff tier). */
const server = { host: env.NO_CONDSTORE_IMAP_HOST, port: env.NO_CONDSTORE_IMAP_PORT };

async function append(ctx: E2EContext, count: number): Promise<void> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword, ...server });
  try {
    await appendBulkMessages(client, "INBOX", count, []);
  } finally {
    await client.logout();
  }
}

async function mirroredUids(ctx: E2EContext): Promise<number[]> {
  const rows = await ctx.pgSql`
    SELECT imap_uid FROM messages
    WHERE folder_id = ${ctx.folderId} AND expunged_at IS NULL ORDER BY imap_uid
  `;
  return rows.map((r) => Number(r.imap_uid));
}

describe("E2E: max_messages_per_folder", () => {
  test("mirrors the newest N, never counts the older ones as deleted, and keeps new mail coming", async () => {
    const ctx = await setupE2EContext({
      emailPrefix: "e2e-maxmsg",
      imapHost: server.host,
      imapPort: server.port,
    });
    try {
      await append(ctx, 5);
      const caps = detectCapabilities(ctx.imapClient.client);
      const sync = new InboundSync(
        ctx.imapClient,
        ctx.db,
        ctx.accountId,
        caps,
        undefined,
        0,
        false,
        2,
      );

      const initial = await sync.fullSync(ctx.folderId, "INBOX", true);
      expect(initial.errors).toEqual([]);
      expect(await mirroredUids(ctx)).toEqual([4, 5]);

      // A later cycle neither fetches the older three nor marks anything deleted.
      await ctx.imapClient.disconnect();
      await ctx.imapClient.connect();
      const cycle = await sync.syncFolder(ctx.folderId, "INBOX");
      expect(cycle.errors).toEqual([]);
      expect(cycle.newMessages).toBe(0);
      expect(cycle.deletedMessages).toBe(0);

      // A restart runs fullSync again: same answer.
      const restart = await sync.fullSync(ctx.folderId, "INBOX", false);
      expect(restart.errors).toEqual([]);
      expect(restart.newMessages).toBe(0);
      expect(restart.deletedMessages).toBe(0);

      // New mail still arrives.
      await append(ctx, 1);
      await ctx.imapClient.disconnect();
      await ctx.imapClient.connect();
      const arrival = await sync.syncFolder(ctx.folderId, "INBOX");
      expect(arrival.errors).toEqual([]);
      expect(arrival.newMessages).toBe(1);
      expect(await mirroredUids(ctx)).toEqual([4, 5, 6]);
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 30_000);
});

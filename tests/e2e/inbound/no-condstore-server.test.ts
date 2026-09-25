import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { describe, expect, test } from "vitest";
import {
  detectCapabilities,
  type ServerCapabilities,
  selectSyncTier,
} from "../../../src/imap/capabilities.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import { OutboundProcessor } from "../../../src/sync/outbound.js";
import {
  connectImap,
  type E2EContext,
  env,
  getDatabaseUrl,
  setupE2EContext,
  teardownE2EContext,
} from "../../setup/e2e-helpers.js";

/**
 * The full-diff tier against a server that really lacks CONDSTORE and QRESYNC, rather
 * than against a QRESYNC session with the tier forced (tier-convergence.test.ts). The
 * capabilities come from the server itself, the way AccountSync gets them in production.
 */

const server = { host: env.NO_CONDSTORE_IMAP_HOST, port: env.NO_CONDSTORE_IMAP_PORT };

async function setup(prefix: string): Promise<E2EContext> {
  return setupE2EContext({ emailPrefix: prefix, imapHost: server.host, imapPort: server.port });
}

/** Runs `fn` on INBOX through a second connection -- another mail client, as far as PostIMAP knows. */
async function asOtherClient<T>(ctx: E2EContext, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword, ...server });
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function appendMessage(ctx: E2EContext, subject: string): Promise<void> {
  const raw = [
    `From: ${ctx.testEmail}`,
    `To: ${ctx.testEmail}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@test.local>`,
    `Date: ${new Date().toUTCString()}`,
    "",
    "Body.",
    "",
  ].join("\r\n");
  await asOtherClient(ctx, (client) => client.append("INBOX", raw, []));
}

/** A fresh session, so the next cycle sees the other client's change as incoming. */
async function reconnect(ctx: E2EContext): Promise<void> {
  await ctx.imapClient.disconnect();
  await ctx.imapClient.connect();
}

async function row(ctx: E2EContext, subject: string) {
  const rows = await ctx.pgSql`
    SELECT id, imap_uid, is_seen, expunged_at FROM messages
    WHERE folder_id = ${ctx.folderId} AND subject = ${subject}
  `;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("E2E: server without CONDSTORE or QRESYNC", () => {
  test("the server's own capabilities select the full-diff tier", async () => {
    const ctx = await setup("e2e-nocs-caps");
    try {
      const caps = detectCapabilities(ctx.imapClient.client);
      expect(caps).toMatchObject({
        condstore: false,
        qresync: false,
        idle: true,
        move: true,
        uidplus: true,
      });
      expect(selectSyncTier(caps)).toBe("full");
    } finally {
      await teardownE2EContext(ctx);
    }
  });

  test("new mail, a read elsewhere, an unread in the app and a delete elsewhere all converge", async () => {
    const ctx = await setup("e2e-nocs-flow");
    try {
      const caps: ServerCapabilities = detectCapabilities(ctx.imapClient.client);
      const sync = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, caps, undefined, 0);
      const outbound = new OutboundProcessor(
        ctx.db,
        getDatabaseUrl(ctx.schema),
        () => ctx.imapClient,
        async () => caps,
        60_000,
        60_000,
        5,
      );

      expect((await sync.fullSync(ctx.folderId, "INBOX", true)).errors).toEqual([]);

      // New mail from outside.
      const subject = `No CONDSTORE ${randomUUID().slice(0, 8)}`;
      await appendMessage(ctx, subject);
      await reconnect(ctx);
      const afterNew = await sync.syncFolder(ctx.folderId, "INBOX");
      expect(afterNew.errors).toEqual([]);
      expect(afterNew.newMessages).toBe(1);
      const created = await row(ctx, subject);
      expect(created.is_seen).toBe(false);
      const uid = Number(created.imap_uid);

      // Read in another client: only a flag moves, no counter does.
      await asOtherClient(ctx, (client) =>
        client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true }),
      );
      await reconnect(ctx);
      const afterRead = await sync.syncFolder(ctx.folderId, "INBOX");
      expect(afterRead.errors).toEqual([]);
      expect(afterRead.updatedFlags).toBe(1);
      expect((await row(ctx, subject)).is_seen).toBe(true);

      // Marked unread in the app: reaches the server.
      await ctx.pgSql`UPDATE messages SET is_seen = false WHERE id = ${created.id}`;
      await outbound.drain(ctx.accountId);
      const serverFlags = await asOtherClient(ctx, async (client) => {
        const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
        return msg === false ? null : msg.flags;
      });
      expect(serverFlags?.has("\\Seen")).toBe(false);

      // Deleted in another client.
      await asOtherClient(ctx, (client) => client.messageDelete({ uid }, { uid: true }));
      await reconnect(ctx);
      const afterDelete = await sync.syncFolder(ctx.folderId, "INBOX");
      expect(afterDelete.errors).toEqual([]);
      expect(afterDelete.deletedMessages).toBe(1);
      expect((await row(ctx, subject)).expunged_at).not.toBeNull();
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 30_000);

  test("inside the skip window a read elsewhere waits, with no window it is seen at once", async () => {
    const ctx = await setup("e2e-nocs-skip");
    try {
      const caps = detectCapabilities(ctx.imapClient.client);
      const subject = `No CONDSTORE skip ${randomUUID().slice(0, 8)}`;
      await appendMessage(ctx, subject);

      // The shipped default: sync.full_tier_max_skip_seconds = 600.
      const windowed = new InboundSync(
        ctx.imapClient,
        ctx.db,
        ctx.accountId,
        caps,
        undefined,
        600_000,
      );
      expect((await windowed.fullSync(ctx.folderId, "INBOX", true)).errors).toEqual([]);
      const uid = Number((await row(ctx, subject)).imap_uid);

      await asOtherClient(ctx, (client) =>
        client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true }),
      );
      await reconnect(ctx);

      const skipped = await windowed.syncFolder(ctx.folderId, "INBOX");
      expect(skipped.errors).toEqual([]);
      expect(skipped.updatedFlags).toBe(0);
      expect((await row(ctx, subject)).is_seen).toBe(false);

      const unwindowed = new InboundSync(ctx.imapClient, ctx.db, ctx.accountId, caps, undefined, 0);
      const seen = await unwindowed.syncFolder(ctx.folderId, "INBOX");
      expect(seen.errors).toEqual([]);
      expect(seen.updatedFlags).toBe(1);
      expect((await row(ctx, subject)).is_seen).toBe(true);
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 30_000);
});

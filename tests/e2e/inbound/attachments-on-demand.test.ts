import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { describe, expect, test } from "vitest";
import { openAttachment } from "../../../src/attachment-download.js";
import { createHealthServer } from "../../../src/health.js";
import { parseMessage } from "../../../src/protocol/mime-parser.js";
import { InboundSync } from "../../../src/sync/inbound.js";
import type { Orchestrator } from "../../../src/sync/orchestrator.js";
import {
  connectImap,
  type E2EContext,
  setupE2EContext,
  teardownE2EContext,
  testCapabilities,
} from "../../setup/e2e-helpers.js";

/**
 * storage.attachments = on_demand against a real server: the text must come out exactly as
 * a full-source parse gives it, attachments must be recorded without their bytes, and the
 * bytes fetched on demand must be the original ones.
 */

const pdf = randomBytes(40_000);
const png = randomBytes(3_000);

async function composeRich(ctx: E2EContext, subject: string): Promise<Buffer> {
  const inner = await new MailComposer({
    from: "someone@test.local",
    to: ctx.testEmail,
    subject: "Forwarded one",
    text: "Inner body.",
  })
    .compile()
    .build();

  return new MailComposer({
    from: ctx.testEmail,
    to: ctx.testEmail,
    subject,
    text: "Bonjour, voici le relevé d'été. Ça marche ?",
    html: '<p>Bonjour, voici le <b>relevé</b> d\'été.</p><img src="cid:logo@test">',
    attachments: [
      { filename: "Relevé été.pdf", content: pdf, contentType: "application/pdf" },
      { filename: "logo.png", content: png, contentType: "image/png", cid: "logo@test" },
      { filename: "forwarded.eml", content: inner, contentType: "message/rfc822" },
    ],
  })
    .compile()
    .build();
}

/** A single-part Latin-1 quoted-printable message, the kind older clients still send. */
function latin1Message(ctx: E2EContext, subject: string): Buffer {
  return Buffer.from(
    [
      `From: ${ctx.testEmail}`,
      `To: ${ctx.testEmail}`,
      `Subject: ${subject}`,
      `Message-ID: <${randomUUID()}@test.local>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Caf=E9 cr=E8me, d=E9j=E0 pay=E9.",
      "",
    ].join("\r\n"),
    "latin1",
  );
}

async function append(ctx: E2EContext, raw: Buffer): Promise<void> {
  const client = await connectImap({ user: ctx.testEmail, password: ctx.testPassword });
  try {
    await client.append("INBOX", raw, []);
  } finally {
    await client.logout();
  }
}

async function rowFor(ctx: E2EContext, subject: string) {
  const [row] = await ctx.pgSql`
    SELECT id, body_text, body_html, raw_source, from_addr, to_addrs, message_id
    FROM messages WHERE folder_id = ${ctx.folderId} AND subject = ${subject}
  `;
  return row;
}

describe("E2E: attachments on demand", () => {
  test("text matches a full parse, attachments are recorded without bytes and served intact", async () => {
    const ctx = await setupE2EContext({ emailPrefix: "e2e-ondemand" });
    try {
      const richSubject = `On demand ${randomUUID().slice(0, 8)}`;
      const latinSubject = `Latin-1 ${randomUUID().slice(0, 8)}`;
      const richRaw = await composeRich(ctx, richSubject);
      const latinRaw = latin1Message(ctx, latinSubject);
      await append(ctx, richRaw);
      await append(ctx, latinRaw);

      const sync = new InboundSync(
        ctx.imapClient,
        ctx.db,
        ctx.accountId,
        testCapabilities,
        undefined,
        0,
        true,
      );
      expect((await sync.fullSync(ctx.folderId, "INBOX", true)).errors).toEqual([]);

      for (const [subject, raw] of [
        [richSubject, richRaw],
        [latinSubject, latinRaw],
      ] as const) {
        const full = await parseMessage(raw);
        const row = await rowFor(ctx, subject);
        expect(row.raw_source).toBeNull();
        expect(row.from_addr).toBe(full.from);
        expect(row.to_addrs).toEqual(full.to);
        expect(row.message_id).toBe(full.messageId);
      }

      // A message without attachments reads exactly as its full source does.
      const latin = await rowFor(ctx, latinSubject);
      expect(latin.body_text).toBe((await parseMessage(latinRaw)).bodyText);
      expect(latin.body_text).toContain("Café crème, déjà payé.");

      // With attachments, two differences from a full parse, both on purpose: an inline
      // image stays a cid: reference instead of a data: URI copied into body_html, and an
      // attached message stays an attachment instead of having its text appended.
      const richRow = await rowFor(ctx, richSubject);
      expect(richRow.body_text).toBe("Bonjour, voici le relevé d'été. Ça marche ?");
      expect(richRow.body_html).toBe(
        '<p>Bonjour, voici le <b>relevé</b> d\'été.</p><img src="cid:logo@test">',
      );

      const rich = await rowFor(ctx, richSubject);
      const attachments = await ctx.pgSql`
        SELECT id, filename, content_type, content_id, size_bytes, data, imap_part
        FROM attachments WHERE message_id = ${rich.id} ORDER BY imap_part
      `;
      expect(attachments.map((a) => a.content_type).sort()).toEqual(
        ["application/pdf", "image/png", "message/rfc822"].sort(),
      );
      for (const a of attachments) {
        expect(a.data).toBeNull();
        expect(a.imap_part).toMatch(/^\d+(\.\d+)*$/);
        expect(a.size_bytes).toBeGreaterThan(0);
      }
      const byType = new Map(attachments.map((a) => [a.content_type, a]));
      expect(byType.get("application/pdf")?.filename).toBe("Relevé été.pdf");
      expect(byType.get("image/png")?.content_id).toBe("<logo@test>");

      // Bytes fetched on demand are the original ones.
      const read = async (id: string): Promise<Buffer> => {
        const opened = await openAttachment(ctx.db, id, { tlsRejectUnauthorized: false });
        expect(opened).not.toBeNull();
        if (!opened) throw new Error("unreachable");
        try {
          if (Buffer.isBuffer(opened.content)) return opened.content;
          const chunks: Buffer[] = [];
          for await (const chunk of opened.content) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks);
        } finally {
          await opened.done();
        }
      };
      const pdfRow = byType.get("application/pdf");
      const pngRow = byType.get("image/png");
      if (!pdfRow || !pngRow) throw new Error("missing attachment rows");
      expect((await read(pdfRow.id)).equals(pdf)).toBe(true);
      expect((await read(pngRow.id)).equals(png)).toBe(true);
      expect(
        await openAttachment(ctx.db, randomUUID(), { tlsRejectUnauthorized: false }),
      ).toBeNull();

      // Over HTTP: token required, bytes served with their name.
      const orchestrator = {
        getStatus: () => ({ running: true, summary: {}, accounts: [] }),
      } as unknown as Orchestrator;
      const token = randomUUID();
      const server = createHealthServer(orchestrator, ctx.db, 0, undefined, {
        token,
        tlsRejectUnauthorized: false,
      });
      try {
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        expect((await fetch(`${base}/attachments/${pdfRow.id}`)).status).toBe(401);
        const wrong = await fetch(`${base}/attachments/${pdfRow.id}`, {
          headers: { Authorization: "Bearer nope" },
        });
        expect(wrong.status).toBe(401);

        const ok = await fetch(`${base}/attachments/${pdfRow.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toBe("application/pdf");
        expect(ok.headers.get("content-disposition")).toContain(
          `filename*=UTF-8''${encodeURIComponent("Relevé été.pdf")}`,
        );
        expect(Buffer.from(await ok.arrayBuffer()).equals(pdf)).toBe(true);

        const missing = await fetch(`${base}/attachments/${randomUUID()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(missing.status).toBe(404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await teardownE2EContext(ctx);
    }
  }, 60_000);
});

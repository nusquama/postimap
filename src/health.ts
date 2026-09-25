import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { type AttachmentDownloadConfig, openAttachment } from "./attachment-download.js";
import type { DavOrchestrator } from "./dav/orchestrator.js";
import type { Database } from "./db/schema.js";
import type { Orchestrator } from "./sync/orchestrator.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("health");

interface HealthResponse {
  status: "ok" | "not_ready";
  accounts: Record<string, number>;
  dav: { accounts: Record<string, number> };
}

export function createHealthServer(
  orchestrator: Orchestrator,
  db: Kysely<Database>,
  port: number,
  davOrchestrator?: DavOrchestrator,
  attachments?: AttachmentDownloadConfig & { token?: string },
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const attachmentMatch = /^\/attachments\/([^/?]+)$/.exec(url);
    if (attachmentMatch && attachments?.token) {
      handleAttachment(db, attachmentMatch[1], attachments, req, res);
    } else if (url === "/healthz") {
      handleHealthz(orchestrator, davOrchestrator, res);
    } else if (url === "/readyz") {
      handleReadyz(orchestrator, db, davOrchestrator, res).catch((err) => {
        log.error({ err }, "readyz check failed");
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_ready", accounts: {}, dav: { accounts: {} } }));
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(port, () => {
    log.info({ port }, "Health server listening");
  });

  return server;
}

/** Liveness: the process is up and serving HTTP. No dependency checks. */
function handleHealthz(
  orchestrator: Orchestrator,
  davOrchestrator: DavOrchestrator | undefined,
  res: http.ServerResponse,
): void {
  const status = orchestrator.getStatus();
  const body: HealthResponse = {
    status: "ok",
    accounts: status.summary,
    dav: { accounts: davOrchestrator?.getStatus().summary ?? {} },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Readiness: this process can serve, not "there is work to do". A fresh deployment with
 * zero accounts yet, or every account currently in backoff, is a perfectly ready process
 * -- pulling it out of the Service's endpoints for that would be wrong for a system whose
 * job is to keep retrying. Per-account sync health belongs in `sync_state`/`dav_accounts`,
 * not here.
 */
async function handleReadyz(
  orchestrator: Orchestrator,
  db: Kysely<Database>,
  davOrchestrator: DavOrchestrator | undefined,
  res: http.ServerResponse,
): Promise<void> {
  const status = orchestrator.getStatus();
  const davStatus = davOrchestrator?.getStatus();

  let dbReachable = true;
  try {
    await sql`SELECT 1`.execute(db);
  } catch {
    dbReachable = false;
  }

  const ready = status.running && dbReachable && (davStatus?.running ?? true);
  const body: HealthResponse = {
    status: ready ? "ok" : "not_ready",
    accounts: status.summary,
    dav: { accounts: davStatus?.summary ?? {} },
  };
  res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** RFC 6266 filename, ASCII fallback plus UTF-8 form. */
function contentDisposition(filename: string | null): string {
  if (!filename) return "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** GET /attachments/:id -- see attachment-download.ts. */
function handleAttachment(
  db: Kysely<Database>,
  attachmentId: string,
  config: AttachmentDownloadConfig & { token?: string },
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (!config.token || !tokenMatches(req.headers.authorization, config.token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  openAttachment(db, attachmentId, config).then(
    (opened) => {
      if (!opened) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": opened.contentType,
        "Content-Disposition": contentDisposition(opened.filename),
        "X-Content-Type-Options": "nosniff",
      });
      if (Buffer.isBuffer(opened.content)) {
        res.end(opened.content);
        void opened.done();
        return;
      }
      const stream = opened.content;
      stream.on("error", (err) => {
        log.error({ err, attachmentId }, "Attachment stream failed");
        res.destroy(err);
      });
      res.on("close", () => void opened.done());
      stream.pipe(res);
    },
    (err: unknown) => {
      log.error({ err, attachmentId }, "Attachment download failed");
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Mail server unavailable" }));
      } else {
        res.destroy();
      }
    },
  );
}

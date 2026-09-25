import postgres from "postgres";
import { createLogger } from "../util/logger.js";
import type { DatabaseSslOptions } from "./connection.js";

const log = createLogger("instance-lock");

/**
 * One PostIMAP per schema.
 *
 * startupRecovery() hands every row left in 'processing' back to 'pending', which is only
 * right when the process that claimed it is gone. With two processes at once -- a deploy
 * that starts the new container before stopping the old one -- each hands the other's
 * in-flight sends back, and mail goes out twice. Migrations have the same problem: a new
 * version must not change the schema under an old one still running.
 *
 * The lock is a session-level advisory lock, keyed on the schema so separate deployments
 * in one database do not block each other, and held on a connection of its own for the
 * life of the process. It needs a real session: a direct connection or a session pooler,
 * never a transaction pooler.
 */
export interface InstanceLock {
  release(): Promise<void>;
}

export interface InstanceLockOptions {
  /** How often to try again while another process holds the lock. */
  retryMs?: number;
  /** How often to check that the connection holding the lock is still the same one. */
  heartbeatMs?: number;
  /** Called once if the lock is lost; the process must stop working at once. */
  onLost: (reason: string) => void;
}

export async function acquireInstanceLock(
  databaseUrl: string,
  ssl: DatabaseSslOptions | undefined,
  options: InstanceLockOptions,
): Promise<InstanceLock> {
  const retryMs = options.retryMs ?? 5_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;

  const pg = postgres(databaseUrl, {
    max: 1,
    // Never recycled: closing this connection is releasing the lock.
    idle_timeout: 0,
    max_lifetime: 0,
    ssl: ssl
      ? { rejectUnauthorized: ssl.rejectUnauthorized, ...(ssl.ca ? { ca: ssl.ca } : {}) }
      : undefined,
  });
  const session = await pg.reserve();

  let waitingLogged = false;
  for (;;) {
    const [row] = await session<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended('postimap:' || current_schema(), 0)) AS locked
    `;
    if (row.locked) break;
    if (!waitingLogged) {
      log.warn("Another PostIMAP holds the instance lock for this schema, waiting for it to stop");
      waitingLogged = true;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  const [{ pid }] = await session<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  log.info({ pid }, "Instance lock acquired");

  let stopped = false;
  const heartbeat = setInterval(() => {
    session<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`.then(
      ([current]) => {
        // A different backend means the connection was replaced and the lock went with it.
        if (!stopped && current.pid !== pid) lost(`connection replaced (pid ${current.pid})`);
      },
      (err: unknown) => {
        if (!stopped) lost(err instanceof Error ? err.message : String(err));
      },
    );
  }, heartbeatMs);
  heartbeat.unref();

  function lost(reason: string): void {
    stopped = true;
    clearInterval(heartbeat);
    log.fatal({ reason }, "Instance lock lost");
    options.onLost(reason);
  }

  return {
    async release() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      // A reserved connection holds end() until its timeout; hand it back first.
      session.release();
      await pg.end({ timeout: 5 });
    },
  };
}

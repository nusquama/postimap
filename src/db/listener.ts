import type { Subscriber } from "pg-listen";
import { createLogger } from "../util/logger.js";
import type { DatabaseSslOptions } from "./connection.js";

const log = createLogger("pg-listener");

// Re-export for consumers
export type { Subscriber } from "pg-listen";

type CreateSubscriberFn = (
  config: { connectionString: string; ssl?: { rejectUnauthorized: boolean; ca?: string } },
  options?: Record<string, unknown>,
) => Subscriber;

let listenerSsl: DatabaseSslOptions | undefined;

/**
 * The TLS options every LISTEN connection uses: `database.ssl`, the same ones the query
 * pool and migrations get. Set once at startup. Without it the LISTEN connections went
 * out in plaintext while everything else used TLS, or failed on a server requiring TLS.
 */
export function setListenerSsl(ssl: DatabaseSslOptions | undefined): void {
  listenerSsl = ssl;
}

/**
 * Thin wrapper around pg-listen for LISTEN/NOTIFY subscription.
 * pg-listen handles auto-reconnect out of the box.
 */
export async function createPgListener(databaseUrl: string): Promise<Subscriber> {
  // Dynamic import to handle CJS default export correctly with NodeNext resolution
  const mod = await import("pg-listen");
  const resolved = typeof mod.default === "function" ? mod.default : mod;
  const createSubscriber = resolved as unknown as CreateSubscriberFn;

  const ssl = listenerSsl
    ? {
        rejectUnauthorized: listenerSsl.rejectUnauthorized,
        ...(listenerSsl.ca ? { ca: listenerSsl.ca } : {}),
      }
    : undefined;

  const subscriber = createSubscriber(
    { connectionString: databaseUrl, ...(ssl ? { ssl } : {}) },
    {
      retryInterval: (attempt: number) => Math.min(500 * 2 ** attempt, 30_000),
      retryTimeout: Number.POSITIVE_INFINITY,
    },
  );

  subscriber.events.on("connected", () => {
    log.info("PG LISTEN connection established");
  });

  subscriber.events.on("reconnect", (attempt: number) => {
    log.info({ attempt }, "PG LISTEN reconnecting");
  });

  subscriber.events.on("error", (error: Error) => {
    log.error({ err: error }, "PG LISTEN connection error");
  });

  return subscriber;
}

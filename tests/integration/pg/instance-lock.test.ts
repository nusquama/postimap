import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acquireInstanceLock, type InstanceLock } from "../../../src/db/instance-lock.js";
import {
  connectPg,
  createTestSchema,
  dropTestSchema,
  getDatabaseUrl,
} from "../../setup/e2e-helpers.js";

let schemaA: string;
let schemaB: string;

beforeAll(async () => {
  const bootstrap = connectPg();
  schemaA = await createTestSchema(bootstrap);
  schemaB = await createTestSchema(bootstrap);
  await bootstrap.end();
});

afterAll(async () => {
  const bootstrap = connectPg();
  await dropTestSchema(bootstrap, schemaA);
  await dropTestSchema(bootstrap, schemaB);
  await bootstrap.end();
});

const noop = () => {};

describe("instance lock", () => {
  test("a second process on the same schema waits until the first releases", async () => {
    const first = await acquireInstanceLock(getDatabaseUrl(schemaA), undefined, { onLost: noop });

    let second: InstanceLock | undefined;
    const waiting = acquireInstanceLock(getDatabaseUrl(schemaA), undefined, {
      retryMs: 50,
      onLost: noop,
    }).then((lock) => {
      second = lock;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(second).toBeUndefined();

    await first.release();
    const acquired = await waiting;
    expect(acquired).toBe(second);
    await acquired.release();
  });

  test("processes on different schemas do not block each other", async () => {
    const a = await acquireInstanceLock(getDatabaseUrl(schemaA), undefined, { onLost: noop });
    const b = await acquireInstanceLock(getDatabaseUrl(schemaB), undefined, { onLost: noop });
    await a.release();
    await b.release();
  });

  test("losing the connection that holds the lock is reported", async () => {
    const reasons: string[] = [];
    const lock = await acquireInstanceLock(getDatabaseUrl(schemaA), undefined, {
      heartbeatMs: 50,
      onLost: (reason) => reasons.push(reason),
    });

    const admin = connectPg();
    try {
      // A bigint advisory key shows in pg_locks as its high and low 32 bits.
      await admin`
        WITH k AS (SELECT hashtextextended(${`postimap:${schemaA}`}, 0) AS key)
        SELECT pg_terminate_backend(l.pid) FROM pg_locks l, k
        WHERE l.locktype = 'advisory' AND l.objsubid = 1
          AND l.classid = ((k.key >> 32) & 4294967295)::oid
          AND l.objid = (k.key & 4294967295)::oid
      `;
    } finally {
      await admin.end();
    }

    const deadline = Date.now() + 5_000;
    while (reasons.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(reasons).toHaveLength(1);
    await lock.release();

    // The lock is free again for the next process.
    const next = await acquireInstanceLock(getDatabaseUrl(schemaA), undefined, { onLost: noop });
    await next.release();
  });
});

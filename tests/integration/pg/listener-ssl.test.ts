import { afterEach, describe, expect, test } from "vitest";
import { createPgListener, setListenerSsl } from "../../../src/db/listener.js";
import { getDatabaseUrl } from "../../setup/e2e-helpers.js";

/**
 * The test server has no TLS, so a LISTEN connection that asks for it is refused. That
 * refusal is the proof the `database.ssl` options reach the LISTEN connection at all.
 */
describe("LISTEN connection TLS", () => {
  afterEach(() => setListenerSsl(undefined));

  test("uses database.ssl when it is set", async () => {
    setListenerSsl({ rejectUnauthorized: false });
    const subscriber = await createPgListener(getDatabaseUrl());
    try {
      await expect(subscriber.connect()).rejects.toThrow(/SSL/i);
    } finally {
      await subscriber.close().catch(() => {});
    }
  });

  test("connects without TLS when database.ssl is not set", async () => {
    const subscriber = await createPgListener(getDatabaseUrl());
    try {
      await subscriber.connect();
    } finally {
      await subscriber.close();
    }
  });
});

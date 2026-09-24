import { afterEach, describe, expect, it, vi } from "vitest";

import { createHealthListener, HEALTH_CHECK_TIMEOUT_MS } from "../../src/health.js";
import type { ApplicationLifecycleState } from "../../src/application-runtime.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let state: ApplicationLifecycleState = "STARTING";
  let discordReady = true;
  const database = vi.fn(() => Promise.resolve());
  const isDiscordReady = vi.fn(() => discordReady);
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const health = createHealthListener({
    port: 0,
    getState: () => state,
    isDiscordReady,
    verifyDatabaseConnection: database,
    setTimer: ((callback: () => void, delay: number) => {
      expect(delay).toBe(HEALTH_CHECK_TIMEOUT_MS);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((id: number) => timers.delete(id)) as typeof clearTimeout,
  });
  const url = (path: string) => `http://127.0.0.1:${health.addressPort()}${path}`;
  return {
    health,
    database,
    isDiscordReady,
    timers,
    url,
    ready: () => {
      state = "READY";
    },
    shuttingDown: () => {
      state = "SHUTTING_DOWN";
    },
    discordDown: () => {
      discordReady = false;
    },
  };
}

const listeners: ReturnType<typeof createHealthListener>[] = [];
afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    listener.quiesce();
    await listener.drain();
  }
});

async function started() {
  const f = fixture();
  listeners.push(f.health);
  await f.health.start();
  expect(f.health.addressPort()).toBeGreaterThan(0);
  return f;
}

async function response(response: Response) {
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    allow: response.headers.get("allow"),
    body: await response.text(),
  };
}

describe("local health listener", () => {
  it("answers liveness without checking dependencies and implements fixed routing", async () => {
    const f = await started();
    expect(await response(await fetch(f.url("/health/live?source=docker")))).toEqual({
      status: 200,
      type: "application/json",
      allow: null,
      body: '{"status":"alive"}',
    });
    expect(f.database).not.toHaveBeenCalled();
    expect(f.isDiscordReady).not.toHaveBeenCalled();
    expect(await response(await fetch(f.url("/health/live/")))).toMatchObject({
      status: 404,
      body: '{"status":"not_found"}',
    });
    expect(await response(await fetch(f.url("/unknown"), { method: "HEAD" }))).toEqual({
      status: 404,
      type: "application/json",
      allow: null,
      body: "",
    });
    expect(await response(await fetch(f.url("/health/ready"), { method: "HEAD" }))).toEqual({
      status: 405,
      type: "application/json",
      allow: "GET",
      body: "",
    });
    expect(await response(await fetch(f.url("/health/live"), { method: "POST" }))).toEqual({
      status: 405,
      type: "application/json",
      allow: "GET",
      body: '{"status":"method_not_allowed"}',
    });
  });

  it("checks lifecycle, current Discord state, and the real database boundary", async () => {
    const f = await started();
    expect(await response(await fetch(f.url("/health/ready")))).toMatchObject({
      status: 503,
      body: '{"status":"unavailable"}',
    });
    expect(f.database).not.toHaveBeenCalled();
    f.ready();
    f.discordDown();
    expect((await fetch(f.url("/health/ready"))).status).toBe(503);
    expect(f.database).not.toHaveBeenCalled();
    const g = await started();
    g.ready();
    expect(await response(await fetch(g.url("/health/ready")))).toEqual({
      status: 200,
      type: "application/json",
      allow: null,
      body: '{"status":"ready"}',
    });
    expect(g.database).toHaveBeenCalledOnce();
    g.shuttingDown();
    expect((await fetch(g.url("/health/ready"))).status).toBe(503);
    expect(g.database).toHaveBeenCalledOnce();
  });

  it("keeps one physical query owned across HTTP timeouts and consumes late rejection", async () => {
    const f = await started();
    f.ready();
    const first = deferred();
    f.database.mockImplementationOnce(() => first.promise);
    const a = fetch(f.url("/health/ready"));
    await vi.waitFor(() => expect(f.database).toHaveBeenCalledOnce());
    const [firstTimer] = f.timers.values();
    firstTimer!();
    expect((await a).status).toBe(503);
    const b = fetch(f.url("/health/ready"));
    await vi.waitFor(() => expect(f.timers.size).toBe(1));
    expect(f.database).toHaveBeenCalledOnce();
    const [secondTimer] = f.timers.values();
    secondTimer!();
    expect((await b).status).toBe(503);
    expect(f.database).toHaveBeenCalledOnce();
    first.reject(new Error("private database detail"));
    await vi.waitFor(() => expect(f.database).toHaveBeenCalledOnce());
    expect((await fetch(f.url("/health/ready"))).status).toBe(200);
    expect(f.database).toHaveBeenCalledTimes(2);
    expect(f.timers.size).toBe(0);
  });

  it("retains a timed-out physical query through shutdown until late resolution", async () => {
    const f = await started();
    f.ready();
    const query = deferred();
    f.database.mockImplementationOnce(() => query.promise);
    const request = fetch(f.url("/health/ready"));
    await vi.waitFor(() => expect(f.timers.size).toBe(1));
    const [timeout] = f.timers.values();
    timeout!();
    expect((await request).status).toBe(503);
    f.shuttingDown();
    f.health.quiesce();
    let drained = false;
    const drain = f.health.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    query.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(f.database).toHaveBeenCalledOnce();
  });

  it("shares an unresolved physical query with concurrent requests and rechecks shutdown", async () => {
    const f = await started();
    f.ready();
    const query = deferred();
    f.database.mockImplementationOnce(() => query.promise);
    const a = fetch(f.url("/health/ready"));
    const b = fetch(f.url("/health/ready"));
    await vi.waitFor(() => expect(f.timers.size).toBe(2));
    expect(f.database).toHaveBeenCalledOnce();
    f.shuttingDown();
    f.health.quiesce();
    query.resolve();
    expect((await a).status).toBe(503);
    expect((await b).status).toBe(503);
    await f.health.drain();
    await f.health.drain();
    expect(f.timers.size).toBe(0);
  });

  it("reports bind failure on the second listener and drains repeated cleanup", async () => {
    const f = await started();
    const duplicate = createHealthListener({
      port: f.health.addressPort()!,
      getState: () => "READY",
      isDiscordReady: () => true,
      verifyDatabaseConnection: async () => {},
    });
    listeners.push(duplicate);
    await expect(duplicate.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    duplicate.quiesce();
    await duplicate.drain();
    await duplicate.drain();
  });
});

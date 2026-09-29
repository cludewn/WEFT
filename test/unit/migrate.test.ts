import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../../src/config.js";

import { ConfigurationError, loadDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { runMigration } from "../../src/migrate.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";

vi.mock("../../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  loadDatabaseConfig: vi.fn(),
}));
vi.mock("../../src/database.js", () => ({ createDatabase: vi.fn() }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: vi.fn() }));

const config = {
  host: "127.0.0.1",
  port: 5432,
  name: "weft_test",
  user: "weft",
  password: "disposable-password",
  ssl: false,
};
const close = vi.fn<() => Promise<void>>();
const client = {} as ReturnType<typeof createDatabase>["client"];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadDatabaseConfig).mockReturnValue(config);
  vi.mocked(createDatabase).mockReturnValue({ client, close, verifyConnection: vi.fn() });
  vi.mocked(migrate).mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("production migration runner", () => {
  it("runs the committed migrations, closes the resource, then reports success", async () => {
    expect(await runMigration()).toBe(true);
    expect(vi.mocked(migrate).mock.calls[0]?.[0]).toBe(client);
    expect(vi.mocked(migrate).mock.calls[0]?.[1].migrationsFolder).toMatch(/\/drizzle\/?$/);
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(migrate).mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]!,
    );
    expect(console.info).toHaveBeenCalledWith('{"event":"migration_succeeded"}');
  });

  it("reports configuration failure without opening a database or exposing values", async () => {
    vi.mocked(loadDatabaseConfig).mockImplementation(() => {
      throw new ConfigurationError(["DATABASE_PASSWORD"]);
    });
    expect(await runMigration()).toBe(false);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '{"event":"configuration_failed","variables":["DATABASE_PASSWORD"]}',
    );
  });

  it("closes on migration failure and reports no raw error", async () => {
    vi.mocked(migrate).mockRejectedValue(new Error("secret-value-must-not-appear"));
    expect(await runMigration()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith('{"event":"migration_failed","stage":"migration"}');
    expect(console.info).not.toHaveBeenCalled();
  });

  it("fails safely when database resource creation throws", async () => {
    vi.mocked(createDatabase).mockImplementation(() => {
      throw new Error("secret-value-must-not-appear");
    });
    expect(await runMigration()).toBe(false);
    expect(migrate).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '{"event":"migration_failed","stage":"migration"}',
    );
    expect(console.info).not.toHaveBeenCalled();
  });

  it("reports both migration and close failures without reporting success", async () => {
    vi.mocked(migrate).mockRejectedValue(new Error("migration-secret-must-not-appear"));
    close.mockRejectedValue(new Error("close-secret-must-not-appear"));
    expect(await runMigration()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenNthCalledWith(
      1,
      '{"event":"migration_failed","stage":"migration"}',
    );
    expect(console.error).toHaveBeenNthCalledWith(
      2,
      '{"event":"migration_failed","stage":"database_close"}',
    );
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.info).not.toHaveBeenCalled();
  });

  it("treats database close failure as a failed migration command", async () => {
    close.mockRejectedValue(new Error("secret-value-must-not-appear"));
    expect(await runMigration()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '{"event":"migration_failed","stage":"database_close"}',
    );
    expect(console.info).not.toHaveBeenCalled();
  });
});

describe("production migration CLI", () => {
  it("exits unsuccessfully on invalid database configuration without disclosing a secret", () => {
    const secret = "cli-secret-must-not-appear";
    const entryPoint = fileURLToPath(new URL("../../src/migrate.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", entryPoint], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        DATABASE_HOST: "127.0.0.1",
        DATABASE_PORT: "invalid",
        DATABASE_NAME: "weft_test",
        DATABASE_USER: "weft",
        DATABASE_PASSWORD: secret,
        DATABASE_SSL: "false",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      '{"event":"configuration_failed","variables":["DATABASE_PORT"]}',
    );
    expect(result.stderr).not.toContain(secret);
  });
});

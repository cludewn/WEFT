import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadConfig,
  loadDatabaseConfig,
  loadTestDatabaseConfig,
} from "../../src/config.js";

const validEnvironment = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "weft_test",
  DATABASE_USER: "weft",
  DATABASE_PASSWORD: "local-test-password",
  DISCORD_TOKEN: "local-test-token",
  DISCORD_APPLICATION_ID: "123456789012345678",
};

describe("loadConfig", () => {
  it("validates and transforms database settings", () => {
    expect(loadConfig(validEnvironment)).toEqual({
      database: {
        host: "127.0.0.1",
        port: 5432,
        name: "weft_test",
        user: "weft",
        password: "local-test-password",
        ssl: false,
      },
      discord: {
        token: "local-test-token",
        applicationId: "123456789012345678",
      },
      healthPort: 3000,
      logLevel: "info",
    });
  });

  it("accepts a strict health port override", () => {
    expect(loadConfig({ ...validEnvironment, HEALTH_PORT: "65535" }).healthPort).toBe(65535);
  });

  it.each(["0", "65536", " 3000", "+3000", "3000.0", "invalid"])(
    "rejects invalid health port %s without echoing the value",
    (value) => {
      expect(() => loadConfig({ ...validEnvironment, HEALTH_PORT: value })).toThrowError(
        new ConfigurationError(["HEALTH_PORT"]),
      );
    },
  );

  it("loads an optional development guild without validating token format", () => {
    const config = loadConfig({
      ...validEnvironment,
      DISCORD_TOKEN: "opaque-token-value",
      DISCORD_GUILD_ID: "234567890123456789",
    });

    expect(config.discord).toEqual({
      token: "opaque-token-value",
      applicationId: "123456789012345678",
      guildId: "234567890123456789",
    });
  });

  it("treats an empty optional guild setting as absent", () => {
    const config = loadConfig({ ...validEnvironment, DISCORD_GUILD_ID: "" });

    expect(config.discord.guildId).toBeUndefined();
  });

  it("supports explicit SSL and log-level settings", () => {
    const config = loadConfig({
      ...validEnvironment,
      DATABASE_SSL: "true",
      LOG_LEVEL: "debug",
    });

    expect(config.database.ssl).toBe(true);
    expect(config.logLevel).toBe("debug");
  });

  it("reports invalid variable names without exposing configuration values", () => {
    const secret = "must-not-appear";

    expect.assertions(3);

    try {
      loadConfig({
        ...validEnvironment,
        DATABASE_PASSWORD: secret,
        DATABASE_PORT: "not-a-port",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).variables).toEqual(["DATABASE_PORT"]);
      expect(String(error)).not.toContain(secret);
    }
  });

  it("reports missing Discord settings without exposing other values", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DISCORD_APPLICATION_ID: undefined,
        DISCORD_TOKEN: undefined,
      }),
    ).toThrowError(new ConfigurationError(["DISCORD_APPLICATION_ID", "DISCORD_TOKEN"]));
  });
});

describe("loadDatabaseConfig", () => {
  it("loads production database settings without application settings", () => {
    const databaseOnly = Object.fromEntries(
      Object.entries(validEnvironment).filter(([name]) => name.startsWith("DATABASE_")),
    );
    expect(loadDatabaseConfig(databaseOnly)).toEqual(loadConfig(validEnvironment).database);
  });

  it("rejects missing or invalid database settings using variable names only", () => {
    const secret = "secret-value-must-not-appear";
    const invalid = {
      ...validEnvironment,
      DATABASE_HOST: undefined,
      DATABASE_PORT: "invalid",
      DATABASE_PASSWORD: secret,
    };
    expect(() => loadDatabaseConfig(invalid)).toThrowError(
      new ConfigurationError(["DATABASE_HOST", "DATABASE_PORT"]),
    );
    try {
      loadDatabaseConfig(invalid);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("does not validate Discord, health, or logging settings", () => {
    expect(
      loadDatabaseConfig({
        ...validEnvironment,
        DISCORD_TOKEN: undefined,
        DISCORD_APPLICATION_ID: undefined,
        DISCORD_GUILD_ID: undefined,
        HEALTH_PORT: "invalid",
        LOG_LEVEL: "invalid",
      }),
    ).toEqual(loadConfig(validEnvironment).database);
  });
});

describe("loadTestDatabaseConfig", () => {
  const validTestEnvironment = {
    TEST_DATABASE_HOST: "127.0.0.1",
    TEST_DATABASE_PORT: "5432",
    TEST_DATABASE_NAME: "weft_integration_test",
    TEST_DATABASE_USER: "weft_test",
    TEST_DATABASE_PASSWORD: "local-integration-test-password",
    TEST_DATABASE_SSL: "false",
  };

  it("loads only dedicated test database settings", () => {
    expect(loadTestDatabaseConfig(validTestEnvironment)).toEqual({
      host: "127.0.0.1",
      port: 5432,
      name: "weft_integration_test",
      user: "weft_test",
      password: "local-integration-test-password",
      ssl: false,
    });
  });

  it("does not fall back to production database settings", () => {
    expect(() => loadTestDatabaseConfig(validEnvironment)).toThrowError(
      new ConfigurationError([
        "TEST_DATABASE_HOST",
        "TEST_DATABASE_NAME",
        "TEST_DATABASE_PASSWORD",
        "TEST_DATABASE_PORT",
        "TEST_DATABASE_SSL",
        "TEST_DATABASE_USER",
      ]),
    );
  });

  it("does not expose test database secrets in validation errors", () => {
    const secret = "test-secret-must-not-appear";

    expect.assertions(2);

    try {
      loadTestDatabaseConfig({
        ...validTestEnvironment,
        TEST_DATABASE_PASSWORD: secret,
        TEST_DATABASE_PORT: "not-a-port",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(secret);
    }
  });
});

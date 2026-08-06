import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig, loadTestDatabaseConfig } from "../../src/config.js";

const validEnvironment = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "weft_test",
  DATABASE_USER: "weft",
  DATABASE_PASSWORD: "local-test-password",
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
      logLevel: "info",
    });
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

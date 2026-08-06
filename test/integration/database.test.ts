import { afterAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";

const config = loadTestDatabaseConfig();
const database = createDatabase(config);

afterAll(async () => {
  await database.close();
});

describe("PostgreSQL connection", () => {
  it("connects to a dedicated test database", async () => {
    await expect(database.verifyConnection()).resolves.toBeUndefined();
  });
});

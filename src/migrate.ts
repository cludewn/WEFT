import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { ConfigurationError, loadDatabaseConfig } from "./config.js";
import { createDatabase } from "./database.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

export async function runMigration(): Promise<boolean> {
  let config;
  try {
    config = loadDatabaseConfig();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "configuration_failed",
        ...(error instanceof ConfigurationError ? { variables: error.variables } : {}),
      }),
    );
    return false;
  }

  let database: ReturnType<typeof createDatabase> | undefined;
  let failed = false;
  try {
    database = createDatabase(config);
    await migrate(database.client, { migrationsFolder });
  } catch {
    console.error(JSON.stringify({ event: "migration_failed", stage: "migration" }));
    failed = true;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error(JSON.stringify({ event: "migration_failed", stage: "database_close" }));
        failed = true;
      }
    }
  }

  if (!failed) {
    console.info(JSON.stringify({ event: "migration_succeeded" }));
  }
  return !failed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMigration().then((succeeded) => {
    if (!succeeded) {
      process.exitCode = 1;
    }
  });
}

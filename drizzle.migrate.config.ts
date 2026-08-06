import { defineConfig } from "drizzle-kit";

import { baseDrizzleConfig } from "./drizzle.config.js";
import { loadConfig } from "./src/config.js";

const config = loadConfig();

export default defineConfig({
  ...baseDrizzleConfig,
  dbCredentials: {
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl: config.database.ssl,
  },
});

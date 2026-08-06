import { defineConfig } from "drizzle-kit";

export const baseDrizzleConfig = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/database.ts",
} as const;

export default defineConfig(baseDrizzleConfig);

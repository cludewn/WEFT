import { defineConfig } from "drizzle-kit";

export const baseDrizzleConfig = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/guild-settings.ts",
} as const;

export default defineConfig(baseDrizzleConfig);

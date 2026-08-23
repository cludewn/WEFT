import { defineConfig } from "drizzle-kit";

export const baseDrizzleConfig = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: [
    "./src/guild-settings.ts",
    "./src/scheduled-action-persistence.ts",
    "./src/thread-persistence.ts",
  ] as string[],
} as const;

export default defineConfig(baseDrizzleConfig);

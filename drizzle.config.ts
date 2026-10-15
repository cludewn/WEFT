import { defineConfig } from "drizzle-kit";

export const baseDrizzleConfig = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: [
    "./src/messages/managed-message-execution-audit.ts",
    "./src/audit/administrative-operation-failure-audit.ts",
    "./src/audit/audit-log-destination-persistence.ts",
    "./src/threads/automatic-close-persistence.ts",
    "./src/guild/guild-settings.ts",
    "./src/guild/guild-configuration-audit.ts",
    "./src/link-previews/link-preview-persistence.ts",
    "./src/messages/managed-message-persistence.ts",
    "./src/messages/recurring-message-persistence.ts",
    "./src/scheduled-action-persistence.ts",
    "./src/messages/scheduled-message-persistence.ts",
    "./src/threads/scheduled-thread-close-persistence.ts",
    "./src/threads/thread-persistence.ts",
  ] as string[],
} as const;

export default defineConfig(baseDrizzleConfig);

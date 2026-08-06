import { z } from "zod";

const portSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));

const databaseSchema = z.object({
  host: z.string().trim().min(1),
  port: portSchema,
  name: z.string().trim().min(1),
  user: z.string().trim().min(1),
  password: z.string().min(1),
  ssl: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const logLevelSchema = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .default("info");

const productionDatabaseVariables = {
  host: "DATABASE_HOST",
  port: "DATABASE_PORT",
  name: "DATABASE_NAME",
  user: "DATABASE_USER",
  password: "DATABASE_PASSWORD",
  ssl: "DATABASE_SSL",
} as const;

const testDatabaseVariables = {
  host: "TEST_DATABASE_HOST",
  port: "TEST_DATABASE_PORT",
  name: "TEST_DATABASE_NAME",
  user: "TEST_DATABASE_USER",
  password: "TEST_DATABASE_PASSWORD",
  ssl: "TEST_DATABASE_SSL",
} as const;

type DatabaseVariableNames = typeof productionDatabaseVariables | typeof testDatabaseVariables;

export type DatabaseConfig = z.output<typeof databaseSchema>;

export type AppConfig = {
  database: DatabaseConfig;
  logLevel: z.output<typeof logLevelSchema>;
};

export class ConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid configuration: ${variables.join(", ")}`);
    this.name = "ConfigurationError";
    this.variables = variables;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const database = parseDatabaseConfig(environment, productionDatabaseVariables, true);
  const logLevelResult = logLevelSchema.safeParse(environment.LOG_LEVEL);

  if (!logLevelResult.success) {
    throw new ConfigurationError(["LOG_LEVEL"]);
  }

  return {
    database,
    logLevel: logLevelResult.data,
  };
}

export function loadTestDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return parseDatabaseConfig(environment, testDatabaseVariables, false);
}

function parseDatabaseConfig(
  environment: NodeJS.ProcessEnv,
  variables: DatabaseVariableNames,
  defaultSslToDisabled: boolean,
): DatabaseConfig {
  const result = databaseSchema.safeParse({
    host: environment[variables.host],
    port: environment[variables.port],
    name: environment[variables.name],
    user: environment[variables.user],
    password: environment[variables.password],
    ssl: environment[variables.ssl] ?? (defaultSslToDisabled ? "false" : undefined),
  });

  if (!result.success) {
    const invalidVariables = [
      ...new Set(
        result.error.issues.flatMap((issue) => {
          const field = issue.path[0];

          return typeof field === "string" && field in variables
            ? [variables[field as keyof DatabaseVariableNames]]
            : [];
        }),
      ),
    ].sort();

    throw new ConfigurationError(invalidVariables);
  }

  return result.data;
}

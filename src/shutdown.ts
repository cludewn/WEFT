export function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

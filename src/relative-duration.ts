const MINIMUM_DURATION_MS = 60_000n;
const MAXIMUM_DURATION_MS = 365n * 24n * 60n * 60n * 1_000n;

const UNIT_MILLISECONDS = {
  m: 60_000n,
  h: 60n * 60n * 1_000n,
  d: 24n * 60n * 60n * 1_000n,
} as const;

export class InvalidRelativeDurationError extends Error {
  constructor() {
    super("Duration must be a single value from 1 minute through 365 days");
    this.name = "InvalidRelativeDurationError";
  }
}

export function parseRelativeDuration(input: string): number {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(input.trim().toLowerCase());
  if (match === null) throw new InvalidRelativeDurationError();

  let durationMs: bigint;
  try {
    durationMs = BigInt(match[1]!) * UNIT_MILLISECONDS[match[2] as keyof typeof UNIT_MILLISECONDS];
  } catch {
    throw new InvalidRelativeDurationError();
  }
  if (
    durationMs < MINIMUM_DURATION_MS ||
    durationMs > MAXIMUM_DURATION_MS ||
    durationMs > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidRelativeDurationError();
  }
  return Number(durationMs);
}

export function addRelativeDuration(anchor: Date, durationMs: number): Date {
  const anchorMs = anchor.getTime();
  if (
    !Number.isSafeInteger(anchorMs) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < Number(MINIMUM_DURATION_MS) ||
    durationMs > Number(MAXIMUM_DURATION_MS)
  ) {
    throw new InvalidRelativeDurationError();
  }

  const resultMs = BigInt(anchorMs) + BigInt(durationMs);
  if (resultMs < BigInt(Number.MIN_SAFE_INTEGER) || resultMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidRelativeDurationError();
  }
  const result = new Date(Number(resultMs));
  if (Number.isNaN(result.getTime())) throw new InvalidRelativeDurationError();
  return result;
}

export function isValidRelativeDurationMilliseconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= Number(MINIMUM_DURATION_MS) &&
    value <= Number(MAXIMUM_DURATION_MS) &&
    value % Number(MINIMUM_DURATION_MS) === 0
  );
}

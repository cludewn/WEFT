export class OperationTimeoutError extends Error {
  constructor() {
    super("Operation timed out");
    this.name = "OperationTimeoutError";
  }
}

export function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new OperationTimeoutError());
    }, timeoutMs);
    timeout.unref();

    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Operation failed"));
      },
    );
  });
}

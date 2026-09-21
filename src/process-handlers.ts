import type { ApplicationRuntime, ProcessControl } from "./application-runtime.js";

type ProcessEvent = "SIGINT" | "SIGTERM" | "unhandledRejection" | "uncaughtException";

export type ProcessHandlerTarget = {
  on: (event: ProcessEvent, listener: (...args: unknown[]) => void) => unknown;
  off: (event: ProcessEvent, listener: (...args: unknown[]) => void) => unknown;
};

export function installProcessHandlers(
  runtime: Pick<ApplicationRuntime, "shutdown" | "handleFatal" | "setProcessHandlerDisposer">,
  processControl: Pick<ProcessControl, "setExitCode">,
  target: ProcessHandlerTarget = process,
): () => void {
  let disposed = false;
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    void runtime.shutdown(signal).catch(() => processControl.setExitCode(1));
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  const handleUnhandledRejection = (reason: unknown) => {
    void runtime.handleFatal("unhandledRejection", reason).catch(() => undefined);
  };
  const handleUncaughtException = (error: unknown) => {
    void runtime.handleFatal("uncaughtException", error).catch(() => undefined);
  };

  target.on("SIGINT", handleSigint);
  target.on("SIGTERM", handleSigterm);
  target.on("unhandledRejection", handleUnhandledRejection);
  target.on("uncaughtException", handleUncaughtException);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    target.off("SIGINT", handleSigint);
    target.off("SIGTERM", handleSigterm);
    target.off("unhandledRejection", handleUnhandledRejection);
    target.off("uncaughtException", handleUncaughtException);
  };
  runtime.setProcessHandlerDisposer(dispose);
  return dispose;
}

import { createServer, type ServerResponse, type IncomingMessage } from "node:http";

import type { ApplicationLifecycleState } from "./application-runtime.js";

export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

type HealthDependencies = {
  port: number;
  getState: () => ApplicationLifecycleState;
  isDiscordReady: () => boolean;
  verifyDatabaseConnection: () => Promise<void>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export function createHealthListener(dependencies: HealthDependencies) {
  let quiescing = false;
  let started = false;
  let startup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let physicalProbe: Promise<boolean> | undefined;
  const activeHandlers = new Set<Promise<void>>();

  const write = (response: ServerResponse, status: number, body: string, head: boolean): void => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    if (status === 405) response.setHeader("Allow", "GET");
    response.end(head ? undefined : body);
  };

  const probe = (): Promise<boolean> => {
    if (physicalProbe !== undefined) return physicalProbe;
    if (quiescing) return Promise.resolve(false);
    let query: Promise<void>;
    try {
      query = Promise.resolve(dependencies.verifyDatabaseConnection());
    } catch {
      return Promise.resolve(false);
    }
    const owned = query.then(
      () => true,
      () => false,
    );
    physicalProbe = owned;
    void owned.then(() => {
      if (physicalProbe === owned) physicalProbe = undefined;
    });
    return owned;
  };

  const checkReady = async (): Promise<boolean> => {
    if (quiescing || dependencies.getState() !== "READY" || !dependencies.isDiscordReady()) {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([
        probe(),
        new Promise<false>((resolve) => {
          timer = (dependencies.setTimer ?? setTimeout)(
            () => resolve(false),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return (
        available &&
        !quiescing &&
        dependencies.getState() === "READY" &&
        dependencies.isDiscordReady()
      );
    } finally {
      if (timer !== undefined) (dependencies.clearTimer ?? clearTimeout)(timer);
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
    } catch {
      pathname = "";
    }
    const head = request.method === "HEAD";
    if (pathname !== "/health/live" && pathname !== "/health/ready") {
      write(response, 404, '{"status":"not_found"}', head);
    } else if (request.method !== "GET") {
      write(response, 405, '{"status":"method_not_allowed"}', head);
    } else if (pathname === "/health/live") {
      write(response, 200, '{"status":"alive"}', false);
    } else {
      const ready = await checkReady();
      write(
        response,
        ready ? 200 : 503,
        ready ? '{"status":"ready"}' : '{"status":"unavailable"}',
        false,
      );
    }
    if (!response.writableFinished && !response.destroyed) {
      await new Promise<void>((resolve) => {
        response.once("finish", resolve);
        response.once("close", resolve);
      });
    }
  };

  const server = createServer((request, response) => {
    const handler = handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        write(response, 503, '{"status":"unavailable"}', request.method === "HEAD");
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
    activeHandlers.add(handler);
    void handler.then(() => activeHandlers.delete(handler));
  });

  const beginClose = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return closing;
  };

  return {
    start(): Promise<void> {
      startup ??= new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(dependencies.port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          started = true;
          resolve();
        });
      });
      return startup;
    },
    quiesce(): void {
      if (quiescing) return;
      quiescing = true;
      if (started) {
        void beginClose().catch(() => undefined);
      } else if (startup !== undefined) {
        closing = startup.then(
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
          () => undefined,
        );
        void closing.catch(() => undefined);
      }
    },
    async drain(): Promise<void> {
      await closing;
      while (activeHandlers.size > 0) {
        await Promise.allSettled([...activeHandlers]);
      }
      await physicalProbe;
    },
    addressPort(): number | undefined {
      const address = server.address();
      return address && typeof address !== "string" ? address.port : undefined;
    },
  };
}

import type { Logger } from "pino";

import type {
  AutomaticClosePersistenceStore,
  AutomaticCloseThreadStatus,
} from "./automatic-close-persistence.js";
import type {
  CurrentScheduledThreadClose,
  ScheduledActionStore,
} from "./scheduled-action-persistence.js";
import { getErrorName } from "./shutdown.js";

export type AutomaticCloseThreadInspection = {
  parentChannelId: string;
  actorCanManage: boolean;
};

export type AutomaticCloseThreadMaintenanceDiscord = {
  inspectThread: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<AutomaticCloseThreadInspection | undefined>;
};

export type AutomaticCloseThreadMaintenanceFailureCode =
  | "UNSUPPORTED_CONTEXT"
  | "USER_MISSING_PERMISSION"
  | "CONTEXT_VALIDATION_FAILURE"
  | "PERSISTENCE_FAILURE";

type MaintenanceFailure = {
  ok: false;
  code: AutomaticCloseThreadMaintenanceFailureCode;
};

export type TrackAutomaticCloseThreadCommandResult =
  | {
      ok: true;
      outcome: "TRACKED" | "ALREADY_TRACKED";
      parentEnabled: boolean;
    }
  | MaintenanceFailure;

export type UntrackAutomaticCloseThreadCommandResult =
  { ok: true; outcome: "EXCLUDED" | "ALREADY_EXCLUDED" } | MaintenanceFailure;

export type AutomaticCloseThreadStatusView = AutomaticCloseThreadStatus & {
  effectiveEnabled: boolean;
  scheduledClose: CurrentScheduledThreadClose | undefined;
};

export type AutomaticCloseThreadStatusCommandResult =
  { ok: true; status: AutomaticCloseThreadStatusView } | MaintenanceFailure;

export type AutomaticCloseThreadMaintenanceService = {
  track: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<TrackAutomaticCloseThreadCommandResult>;
  untrack: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<UntrackAutomaticCloseThreadCommandResult>;
  status: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<AutomaticCloseThreadStatusCommandResult>;
};

type Dependencies = {
  discord: AutomaticCloseThreadMaintenanceDiscord;
  persistence: Pick<
    AutomaticClosePersistenceStore,
    "trackThread" | "addThreadExclusion" | "findThreadStatus"
  >;
  scheduledActions: Pick<ScheduledActionStore, "findCurrentThreadClose">;
  logger: Pick<Logger, "warn">;
  now?: () => Date;
};

type MaintenanceOperation = "TRACK" | "UNTRACK" | "STATUS";

export function createAutomaticCloseThreadMaintenanceService({
  discord,
  persistence,
  scheduledActions,
  logger,
  now = () => new Date(),
}: Dependencies): AutomaticCloseThreadMaintenanceService {
  const inspect = async (
    operation: MaintenanceOperation,
    guildId: string,
    threadId: string,
    actorId: string,
  ): Promise<AutomaticCloseThreadInspection | MaintenanceFailure> => {
    let inspection: AutomaticCloseThreadInspection | undefined;
    try {
      inspection = await discord.inspectThread(guildId, threadId, actorId);
    } catch (error) {
      logFailure(
        logger,
        operation,
        guildId,
        threadId,
        undefined,
        "CONTEXT_VALIDATION_FAILURE",
        error,
      );
      return { ok: false, code: "CONTEXT_VALIDATION_FAILURE" };
    }

    if (inspection === undefined) {
      return { ok: false, code: "UNSUPPORTED_CONTEXT" };
    }
    if (!inspection.actorCanManage) {
      return { ok: false, code: "USER_MISSING_PERMISSION" };
    }
    return inspection;
  };

  return {
    async track(guildId, threadId, actorId) {
      const inspection = await inspect("TRACK", guildId, threadId, actorId);
      if ("ok" in inspection) {
        return inspection;
      }

      try {
        // Capture the baseline only after Discord context and permission validation completes.
        const trackedAt = now();
        const result = await persistence.trackThread({
          guildId,
          threadId,
          parentChannelId: inspection.parentChannelId,
          trackedAt,
        });
        return {
          ok: true,
          outcome: result.exclusionRemoved ? "TRACKED" : "ALREADY_TRACKED",
          parentEnabled: result.parentEnabled,
        };
      } catch (error) {
        logFailure(
          logger,
          "TRACK",
          guildId,
          threadId,
          inspection.parentChannelId,
          "PERSISTENCE_FAILURE",
          error,
        );
        return { ok: false, code: "PERSISTENCE_FAILURE" };
      }
    },
    async untrack(guildId, threadId, actorId) {
      const inspection = await inspect("UNTRACK", guildId, threadId, actorId);
      if ("ok" in inspection) {
        return inspection;
      }

      try {
        const changed = await persistence.addThreadExclusion(guildId, threadId);
        return { ok: true, outcome: changed ? "EXCLUDED" : "ALREADY_EXCLUDED" };
      } catch (error) {
        logFailure(
          logger,
          "UNTRACK",
          guildId,
          threadId,
          inspection.parentChannelId,
          "PERSISTENCE_FAILURE",
          error,
        );
        return { ok: false, code: "PERSISTENCE_FAILURE" };
      }
    },
    async status(guildId, threadId, actorId) {
      const inspection = await inspect("STATUS", guildId, threadId, actorId);
      if ("ok" in inspection) {
        return inspection;
      }

      try {
        const [automaticClose, scheduledClose] = await Promise.all([
          persistence.findThreadStatus(guildId, threadId, inspection.parentChannelId),
          scheduledActions.findCurrentThreadClose(guildId, threadId),
        ]);
        return {
          ok: true,
          status: {
            ...automaticClose,
            effectiveEnabled: automaticClose.parentEnabled && !automaticClose.excluded,
            scheduledClose,
          },
        };
      } catch (error) {
        logFailure(
          logger,
          "STATUS",
          guildId,
          threadId,
          inspection.parentChannelId,
          "PERSISTENCE_FAILURE",
          error,
        );
        return { ok: false, code: "PERSISTENCE_FAILURE" };
      }
    },
  };
}

function logFailure(
  logger: Pick<Logger, "warn">,
  operation: MaintenanceOperation,
  guildId: string,
  threadId: string,
  parentChannelId: string | undefined,
  failureCode: Extract<
    AutomaticCloseThreadMaintenanceFailureCode,
    "CONTEXT_VALIDATION_FAILURE" | "PERSISTENCE_FAILURE"
  >,
  error: unknown,
): void {
  logger.warn(
    {
      event: "automatic_close_thread_maintenance_failed",
      operation,
      guildId,
      threadId,
      ...(parentChannelId === undefined ? {} : { parentChannelId }),
      failureCode,
      errorName: getErrorName(error),
    },
    "Automatic close thread maintenance failed",
  );
}

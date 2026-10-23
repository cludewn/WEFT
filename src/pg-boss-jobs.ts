import type { FindJobsOptions, JobWithMetadata, PgBoss } from "pg-boss";

const PAGE_SIZE = 1_000;
const states = new Set(["created", "retry", "active", "completed", "cancelled", "failed"]);
type Job = JobWithMetadata<unknown>;
type Reader = { findJobs: (queue: string, options?: FindJobsOptions) => Promise<Job[]> };

export function isEffectiveJob(job: Job): boolean {
  return job.state === "created" || job.state === "retry" || job.state === "active";
}

function validatePage(value: unknown, queue: string, key: string, limit: number): Job[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error("Invalid pg-boss job page");
  const ids = new Set<string>();
  for (const job of value as Job[]) {
    if (
      job === null ||
      typeof job !== "object" ||
      typeof job.id !== "string" ||
      job.id.length === 0 ||
      ids.has(job.id) ||
      job.name !== queue ||
      job.singletonKey !== key ||
      !states.has(job.state) ||
      !(job.createdOn instanceof Date) ||
      !Number.isFinite(job.createdOn.getTime()) ||
      !(job.startAfter instanceof Date) ||
      !Number.isFinite(job.startAfter.getTime())
    )
      throw new Error("Invalid pg-boss job metadata");
    ids.add(job.id);
  }
  return value as Job[];
}

// Only one page and its predecessor's IDs are retained. This is an observation, not a snapshot:
// callers must still authorize execution from PostgreSQL and confirm mutations with fresh reads.
export async function* findJobPagesByKey(
  boss: Reader,
  queue: string,
  key: string,
): AsyncGenerator<Job[], void> {
  let after: string | undefined;
  let previousIds = new Set<string>();
  let lastCreatedOn = -Infinity;
  // Constant-space cycle detection also catches longer cursor cycles within one JS millisecond.
  let checkpoint: string | undefined;
  let distance = 0;
  let span = 1;
  for (;;) {
    const page = validatePage(
      await boss.findJobs(queue, {
        key,
        limit: PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      }),
      queue,
      key,
      PAGE_SIZE,
    );
    for (const job of page) {
      if (previousIds.has(job.id) || job.createdOn.getTime() < lastCreatedOn)
        throw new Error("pg-boss job page did not advance");
      // PostgreSQL retains microseconds internally; Date does not. Do not impose UUID order
      // on distinct timestamps that happen to round down to the same millisecond here.
      lastCreatedOn = job.createdOn.getTime();
    }
    yield page;
    if (page.length < PAGE_SIZE) return;
    after = page.at(-1)!.id;
    if (after === checkpoint) throw new Error("pg-boss job cursor repeated");
    distance += 1;
    if (distance === span) {
      checkpoint = after;
      distance = 0;
      span *= 2;
    }
    previousIds = new Set(page.map((job) => job.id));
  }
}

export async function findJobById(boss: Reader, queue: string, key: string, id: string) {
  const page = validatePage(await boss.findJobs(queue, { key, id, limit: 1 }), queue, key, 1);
  if (page.some((job) => job.id !== id)) throw new Error("pg-boss returned a different job");
  return page[0];
}

export async function cancelJobsByKey(
  boss: Reader & Pick<PgBoss, "cancel">,
  queue: string,
  key: string,
  matches: (job: Job) => boolean,
): Promise<{ outcome: "CONFIRMED" | "UNCONFIRMED"; matchedDeliveryCount: number }> {
  let matchedDeliveryCount = 0;
  try {
    for await (const page of findJobPagesByKey(boss, queue, key)) {
      const ids = page.filter(matches).map((job) => job.id);
      matchedDeliveryCount += ids.length;
      if (ids.length === 0) continue;
      try {
        await boss.cancel(queue, ids);
      } catch {
        // Cancellation may have applied despite response loss. Only fresh reads confirm it.
      }
      for (const id of ids) {
        const job = await findJobById(boss, queue, key, id);
        if (job !== undefined && isEffectiveJob(job))
          return { outcome: "UNCONFIRMED", matchedDeliveryCount };
      }
    }
    // Known IDs alone cannot establish absence of other jobs with the same singleton key.
    for await (const page of findJobPagesByKey(boss, queue, key)) {
      if (page.some(matches)) return { outcome: "UNCONFIRMED", matchedDeliveryCount };
    }
    return { outcome: "CONFIRMED", matchedDeliveryCount };
  } catch {
    return { outcome: "UNCONFIRMED", matchedDeliveryCount };
  }
}

import type { FindJobsOptions, JobWithMetadata } from "pg-boss";
import { vi } from "vitest";

export function storedJob(
  queue: string,
  key: string,
  index: number,
  overrides: Partial<JobWithMetadata<unknown>> = {},
): JobWithMetadata<unknown> {
  return {
    id: `job-${index}`,
    name: queue,
    singletonKey: key,
    state: "completed",
    createdOn: new Date(1_600_000_000_000 + index),
    startAfter: new Date("2030-01-01Z"),
    data: {},
    ...overrides,
  } as JobWithMetadata<unknown>;
}

// Models the public bounded API, including missing anchors and fresh state on every read.
export function jobQuery(jobs: JobWithMetadata<unknown>[]) {
  return vi.fn((queue: string, options: FindJobsOptions = {}) => {
    let rows = jobs.filter((job) => job.name === queue && job.singletonKey === options.key);
    if (options.id !== undefined) rows = rows.filter((job) => job.id === options.id);
    if (options.after !== undefined) {
      const index = rows.findIndex((job) => job.id === options.after);
      if (index === -1)
        return Promise.reject(new Error("findJobs: after names a row that no longer exists"));
      rows = rows.slice(index + 1);
    }
    return Promise.resolve(rows.slice(0, options.limit ?? 1000).map((job) => ({ ...job })));
  });
}

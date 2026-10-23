import type { FindJobsOptions, JobWithMetadata, PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import {
  cancelJobsByKey,
  findJobById,
  findJobPagesByKey,
  isEffectiveJob,
} from "../../src/pg-boss-jobs.js";
import { jobQuery, storedJob } from "./pg-boss-jobs-fixture.js";

type Finder = (name: string, options?: FindJobsOptions) => Promise<JobWithMetadata<unknown>[]>;
const queue = "test-queue";
const key = "action";
const history = (count = 2001) => Array.from({ length: count }, (_, i) => storedJob(queue, key, i));
async function ids(boss: { findJobs: Finder }) {
  const result: string[] = [];
  for await (const page of findJobPagesByKey(boss, queue, key))
    result.push(...page.map((job) => job.id));
  return result;
}

describe("bounded pg-boss job queries", () => {
  it.each([0, 1, 999, 1000, 1001, 2001])(
    "visits %s jobs exactly once with explicit cursors",
    async (count) => {
      const jobs = history(count);
      const boss = { findJobs: jobQuery(jobs) };
      expect(await ids(boss)).toEqual(jobs.map((job) => job.id));
      expect(boss.findJobs).toHaveBeenNthCalledWith(1, queue, { key, limit: 1000 });
      if (count >= 1000)
        expect(boss.findJobs).toHaveBeenNthCalledWith(2, queue, {
          key,
          limit: 1000,
          after: "job-999",
        });
    },
  );

  it("propagates a mid-scan DB failure instead of returning a partial result", async () => {
    const findJobs = jobQuery(history());
    findJobs
      .mockResolvedValueOnce(history(1000))
      .mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(ids({ findJobs })).rejects.toThrow("DB unavailable");
  });

  it("propagates disappearance of the previous page's anchor", async () => {
    const jobs = history();
    const query = jobQuery(jobs);
    const findJobs = vi.fn<Finder>(async (name, options) => {
      if (options?.after !== undefined)
        jobs.splice(
          jobs.findIndex((job) => job.id === options.after),
          1,
        );
      return query(name, options);
    });
    await expect(ids({ findJobs })).rejects.toThrow("no longer exists");
  });

  it.each([null, {}, [null], [{ id: "bad", state: "unknown" }]])(
    "rejects malformed pages: %j",
    async (response) => {
      const findJobs = vi.fn<Finder>().mockResolvedValue(response as never);
      await expect(ids({ findJobs })).rejects.toThrow();
    },
  );

  it.each([
    { state: "unknown" },
    { singletonKey: "other" },
    { name: "other" },
    { createdOn: new Date(NaN) },
    { startAfter: null },
    { id: "" },
  ])("rejects invalid job metadata %j", async (override) => {
    const findJobs = vi
      .fn<Finder>()
      .mockResolvedValue([storedJob(queue, key, 0, override as Partial<JobWithMetadata<unknown>>)]);
    await expect(ids({ findJobs })).rejects.toThrow();
  });

  it("rejects oversized, duplicate, overlapping and backward pages", async () => {
    for (const pages of [
      [history(1001)],
      [[storedJob(queue, key, 0), storedJob(queue, key, 0)]],
      [history(1000), [storedJob(queue, key, 999)]],
      [history(1000), [storedJob(queue, key, 1, { id: "different" })]],
    ]) {
      const findJobs = vi.fn<Finder>();
      for (const page of pages) findJobs.mockResolvedValueOnce(page);
      await expect(ids({ findJobs })).rejects.toThrow();
    }
  });

  it("detects longer cursor cycles without retaining the full history", async () => {
    const pages = [0, 1000, 2000].map((offset) =>
      history(1000).map((job, i) => ({
        ...job,
        id: `cycle-${offset + i}`,
        createdOn: new Date(0),
      })),
    );
    let call = 0;
    const findJobs = vi.fn<Finder>().mockImplementation(() => Promise.resolve(pages[call++ % 3]!));
    await expect(ids({ findJobs })).rejects.toThrow("cursor repeated");
    expect(call).toBeLessThan(12);
  });

  it("accepts UUID order differences within a rounded JS millisecond", async () => {
    const jobs = history(1001).map((job, i) => ({
      ...job,
      id: `reverse-${1001 - i}`,
      createdOn: new Date(0),
    }));
    expect(await ids({ findJobs: jobQuery(jobs) })).toEqual(jobs.map((job) => job.id));
  });

  it("checks a known ID directly and rejects a mismatched result", async () => {
    const boss = { findJobs: jobQuery(history()) };
    expect((await findJobById(boss, queue, key, "job-2000"))?.id).toBe("job-2000");
    expect(boss.findJobs).toHaveBeenCalledWith(queue, { key, id: "job-2000", limit: 1 });
    boss.findJobs.mockResolvedValueOnce([storedJob(queue, key, 0)]);
    await expect(findJobById(boss, queue, key, "job-2000")).rejects.toThrow("different job");
  });
});

describe("paginated cancellation confirmation", () => {
  function fixture() {
    const jobs = history();
    for (const [index, state] of [
      [5, "created"],
      [1005, "retry"],
      [2000, "active"],
    ] as const)
      jobs[index]!.state = state;
    const findJobs = jobQuery(jobs);
    const cancel = vi.fn<PgBoss["cancel"]>().mockImplementation((_name, input) => {
      const selected = Array.isArray(input) ? input : [input];
      for (const job of jobs) if (selected.includes(job.id)) job.state = "cancelled";
      return Promise.reject(new Error("response lost after applying cancel"));
    });
    return { jobs, boss: { findJobs, cancel } };
  }

  it("cancels across pages once each and confirms applied response loss", async () => {
    const { jobs, boss } = fixture();
    expect(await cancelJobsByKey(boss, queue, key, isEffectiveJob)).toEqual({
      outcome: "CONFIRMED",
      matchedDeliveryCount: 3,
    });
    expect(boss.cancel.mock.calls.map((call) => call[1])).toEqual([
      ["job-5"],
      ["job-1005"],
      ["job-2000"],
    ]);
    expect(jobs.filter(isEffectiveJob)).toEqual([]);
    expect(jobs.filter((job) => job.state === "completed")).toHaveLength(1998);
  });

  it("does not confirm partial cancellation, timeout, or a target that remains effective", async () => {
    const { boss } = fixture();
    boss.cancel.mockRejectedValue(new Error("cancel timed out"));
    expect(await cancelJobsByKey(boss, queue, key, isEffectiveJob)).toEqual({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 1,
    });
  });

  it("does not infer same-key absence from known-ID confirmation", async () => {
    const { jobs, boss } = fixture();
    const query = jobQuery(jobs);
    let scans = 0;
    boss.findJobs.mockImplementation((name, options) => {
      if (options?.id === undefined && options?.after === undefined && ++scans === 2)
        jobs[1005]!.state = "created";
      return query(name, options);
    });
    expect((await cancelJobsByKey(boss, queue, key, isEffectiveJob)).outcome).toBe("UNCONFIRMED");
  });

  it("reports failure after partial mutation and preserves the matched count", async () => {
    const { boss } = fixture();
    const query = boss.findJobs.getMockImplementation()!;
    boss.findJobs.mockImplementation((name, options) =>
      options?.after === "job-999"
        ? Promise.reject(new Error("anchor lost"))
        : query(name, options),
    );
    expect(await cancelJobsByKey(boss, queue, key, isEffectiveJob)).toEqual({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 1,
    });
  });

  it("cannot confirm a failure during the final complete scan", async () => {
    const { boss } = fixture();
    const query = boss.findJobs.getMockImplementation()!;
    let scans = 0;
    boss.findJobs.mockImplementation((name, options) => {
      if (options?.id === undefined && options?.after === undefined) scans++;
      if (scans === 2 && options?.after !== undefined)
        return Promise.reject(new Error("confirmation failed"));
      return query(name, options);
    });
    expect(await cancelJobsByKey(boss, queue, key, isEffectiveJob)).toEqual({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 3,
    });
  });
});

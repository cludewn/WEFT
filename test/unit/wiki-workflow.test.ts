import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/wiki.yml"),
  "utf8",
);
const cli = readFileSync(resolve(import.meta.dirname, "../../scripts/wiki/publish-cli.ts"), "utf8");
const publisher = readFileSync(
  resolve(import.meta.dirname, "../../scripts/wiki/publish.ts"),
  "utf8",
);

describe("dedicated Wiki workflow safety contract", () => {
  it("allows only main push and explicitly gated manual dispatch, independently of CI", () => {
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/pull_request|workflow_run|workflow_call|needs:|services:/);
    expect(workflow).toContain(
      "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    expect(cli).toContain('process.env.GITHUB_REF !== "refs/heads/main"');
    expect(cli).toContain('["push", "workflow_dispatch"]');
  });

  it("serializes publishes without cancelling active work and uses job-scoped contents write", () => {
    expect(workflow).toMatch(/permissions:\n {2}contents: read/);
    expect(workflow).toMatch(/ {4}permissions:\n {6}contents: write/);
    expect(workflow).toMatch(
      /concurrency:\n {2}group: weft-wiki-publication\n {2}cancel-in-progress: false/,
    );
    expect(workflow).not.toMatch(/write-all|secrets\.(?!GITHUB_TOKEN)[A-Z_]+/);
  });

  it("pins every Action to a full SHA and avoids persisted credentials, arbitrary ref and run SHA", () => {
    const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^[a-z/-]+@[0-9a-f]{40}$/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("ref: main");
    expect(workflow).toContain("fetch --no-tags origin refs/heads/main");
    expect(workflow).toContain('checkout --detach "$source_sha"');
    expect(workflow).not.toMatch(
      /github\.sha|GITHUB_SHA|inputs\.|--force(?:\s|\b)|--mirror|https:\/\/[^\s]+@/,
    );
    expect(publisher).not.toMatch(/"--force"|"--mirror"/);
  });

  it("validates before publication and records incomplete runs", () => {
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("--frozen-lockfile");
    expect(workflow.indexOf("corepack pnpm wiki:check")).toBeLessThan(
      workflow.indexOf("corepack pnpm wiki:publish"),
    );
    expect(workflow).toContain("test/unit/wiki-publish.test.ts");
    expect(workflow).toContain("if: always() && steps.publication.outcome != 'success'");
    expect(cli).toContain("process.exitCode = 1");
    expect(cli).toContain("Confirmed Wiki revision");
  });

  it.each([
    { ref: "refs/heads/feature", event: "workflow_dispatch", token: "non-sensitive-fixture" },
    { ref: "refs/pull/1/merge", event: "pull_request", token: "non-sensitive-fixture" },
    { ref: "refs/heads/main", event: "workflow_dispatch", token: "" },
  ])(
    "refuses an unapproved runtime publication context before any Git work: %j",
    ({ ref, event, token }) => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/wiki/publish-cli.ts"],
        {
          cwd: resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          timeout: 10_000,
          env: {
            GITHUB_REF: ref,
            GITHUB_EVENT_NAME: event,
            GITHUB_REPOSITORY: "fixture/WEFT",
            WIKI_TOKEN: token,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("UNAPPROVED_PUBLICATION_CONTEXT");
      expect(result.stderr).not.toContain("non-sensitive-fixture");
      expect(result.stderr).not.toContain("GIT_OPERATION_FAILED");
    },
  );

  it("uses askpass without embedding a credential in a command or remote URL", () => {
    const helper = resolve(import.meta.dirname, "../../scripts/wiki/askpass.sh");
    const username = spawnSync("sh", [helper, "Username for 'https://github.com':"], {
      encoding: "utf8",
      env: { WIKI_TOKEN: "non-sensitive-fixture" },
    });
    const password = spawnSync(
      "sh",
      [helper, "Password for 'https://x-access-token@github.com':"],
      { encoding: "utf8", env: { WIKI_TOKEN: "non-sensitive-fixture" } },
    );
    const unknown = spawnSync("sh", [helper, "Unexpected prompt"], {
      encoding: "utf8",
      env: { WIKI_TOKEN: "non-sensitive-fixture" },
    });
    expect(username.status).toBe(0);
    expect(username.stdout).toBe("x-access-token\n");
    expect(password.status).toBe(0);
    expect(password.stdout).toBe("non-sensitive-fixture\n");
    expect(username.stderr + password.stderr + unknown.stderr).toBe("");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/image.yml"), "utf8");
const [verification, publication] = workflow.split("\n  publish:\n") as [string, string];
const temporary: string[] = [];
const sha = "a".repeat(40);

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "weft-image-"));
  temporary.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  return { directory, bin, path: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
}

describe("image release validation", () => {
  function check(overrides: Record<string, string> = {}, version = "1.0.0") {
    const { directory, bin, path } = fixture();
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
    const output = join(directory, "output");
    const calls = join(directory, "calls");
    writeFileSync(output, "");
    writeFileSync(calls, "");
    // Fake only the Git boundary; no branches, commits, or tags are created.
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$GIT_CALLS"
case "$*" in
  'rev-parse HEAD') echo "$HEAD_SHA" ;;
  'rev-parse --verify refs/tags/v1.0.0^{commit}')
    test "$TAG_EXISTS" = true
    echo "$TAG_SHA" ;;
  "merge-base --is-ancestor $HEAD_SHA refs/remotes/origin/main") test "$ON_MAIN" = true ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [join(root, "scripts/check-image-release.sh")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: path,
        GITHUB_EVENT_NAME: "release",
        GITHUB_REPOSITORY: "cludewn/WEFT",
        GITHUB_REF: "refs/tags/v1.0.0",
        GITHUB_SHA: sha,
        RELEASE_TAG: "v1.0.0",
        GITHUB_OUTPUT: output,
        GIT_CALLS: calls,
        HEAD_SHA: sha,
        TAG_SHA: sha,
        TAG_EXISTS: "true",
        ON_MAIN: "true",
        ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { result, output: readFileSync(output, "utf8"), calls: readFileSync(calls, "utf8") };
  }

  it("accepts the matching stable tag only after checking the event commit and main ancestry", () => {
    const { result, output, calls } = check();
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe("tag=v1.0.0\n");
    expect(calls).toContain("rev-parse --verify refs/tags/v1.0.0^{commit}");
    expect(calls).toContain(`merge-base --is-ancestor ${sha} refs/remotes/origin/main`);
  });

  it.each([
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REPOSITORY: "fork/WEFT" },
    { GITHUB_REF: "refs/heads/main" },
    { RELEASE_TAG: "" },
    { RELEASE_TAG: "v0.9.0" },
    { RELEASE_TAG: "1.0.0" },
    { RELEASE_TAG: "v01.0.0" },
    { RELEASE_TAG: "v1.0" },
    { RELEASE_TAG: "v1.0.0-rc.1" },
    { RELEASE_TAG: "v1.0.0+build" },
    { RELEASE_TAG: "v1.0.0\n" },
    { RELEASE_TAG: "v1.0.0; exit 0" },
    { GITHUB_SHA: "b".repeat(40) },
    { TAG_SHA: "b".repeat(40) },
    { TAG_EXISTS: "false" },
    { ON_MAIN: "false" },
  ])("rejects invalid publication context without producing a tag output: %j", (overrides) => {
    const { result, output } = check(overrides);
    expect(result.status).not.toBe(0);
    expect(output).toBe("");
  });

  it("rejects a package version mismatch before any Git checks", () => {
    const { result, output, calls } = check({}, "0.9.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match package.json");
    expect(output).toBe("");
    expect(calls).toBe("");
  });
});

describe("offline image verification", () => {
  function check(options: { missing?: string; invalid?: string; user?: string } = {}) {
    const { directory, bin, path } = fixture();
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    for (const entry of ["index.js", "migrate.js", "deploy-commands.js"]) {
      if (entry === options.missing) continue;
      writeFileSync(
        join(directory, "dist", entry),
        entry === options.invalid ? "invalid syntax {" : 'throw new Error("must never execute");',
      );
    }
    writeFileSync(
      join(directory, "image.json"),
      JSON.stringify([
        {
          Config: {
            User: options.user ?? "node",
            WorkingDir: "/app",
            Cmd: ["node", "dist/index.js"],
          },
        },
      ]),
    );
    // Execute the actual file/syntax probe on fixtures, substituting only Docker isolation.
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash
set -eu
if [[ "$*" == 'image inspect weft:fixture' ]]; then
  cat image.json
elif [[ "$1" == run ]]; then
  while [[ "$1" != --input-type=module ]]; do shift; done
  exec node "$@"
else
  exit 2
fi
`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [join(root, "scripts/verify-image.sh"), "weft:fixture"], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: path },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("must never execute");
    return result;
  }

  it("parses all entrypoints without importing or running them", () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("all three runtime entrypoints verified");
  });

  it.each(["index.js", "migrate.js", "deploy-commands.js"])("rejects missing %s", (missing) => {
    expect(check({ missing }).status).not.toBe(0);
  });

  it("rejects invalid compiled JavaScript", () => {
    expect(check({ invalid: "migrate.js" }).status).not.toBe(0);
  });

  it("rejects a root runtime user", () => {
    expect(check({ user: "root" }).status).not.toBe(0);
  });
});

describe("container workflow publication boundary", () => {
  it("triggers only for PRs and published releases, with release guards on both jobs", () => {
    expect(workflow).toContain("pull_request:\n    branches: [main]");
    expect(workflow).toContain("release:\n    types: [published]");
    expect(workflow).not.toMatch(
      /\n {2}(push|workflow_dispatch|workflow_run|pull_request_target):/,
    );
    for (const job of [verification, publication]) {
      expect(job).toContain("github.repository == 'cludewn/WEFT'");
      expect(job).toContain("github.event_name == 'release'");
      expect(job).toContain("github.event.action == 'published'");
      expect(job).toContain("!github.event.release.draft");
      expect(job).toContain("!github.event.release.prerelease");
    }
  });

  it("grants package write only to the isolated release publisher", () => {
    expect(verification).toContain("permissions:\n  contents: read");
    expect(verification).not.toMatch(/packages:|docker login|docker push|secrets\./);
    expect(publication).toContain("permissions:\n      packages: write");
    expect(publication).not.toMatch(/actions\/checkout|docker (build|run)|pnpm|bash scripts\//);
    expect(publication).toContain("secrets.GITHUB_TOKEN");
    expect(publication).toContain('--username "$GITHUB_ACTOR" --password-stdin');
    expect(workflow).not.toMatch(/write-all|contents: write|secrets\.(?!GITHUB_TOKEN)|:latest/);
    for (const [, action] of workflow.matchAll(/uses: (\S+)/g)) {
      expect(action).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    }
    expect(verification).toContain("persist-credentials: false");
  });

  it("requires all verification to succeed and transfers exactly that image", () => {
    expect(publication).toContain("needs: verify");
    expect(publication).toContain("needs.verify.result == 'success'");
    expect(workflow).not.toMatch(/continue-on-error|if: always\(\)/);
    const gates = [
      "bash scripts/check-image-release.sh",
      "corepack pnpm test",
      "docker build",
      "bash scripts/verify-image.sh",
      "docker save",
      "actions/upload-artifact@",
    ];
    for (let i = 1; i < gates.length; i++) {
      expect(verification.indexOf(gates[i - 1]!)).toBeLessThan(verification.indexOf(gates[i]!));
    }
    expect(publication).toContain("artifact-ids: ${{ needs.verify.outputs.artifact-id }}");
    expect(publication).toContain("sha256sum --check --status");
    expect(publication).toContain(
      'test "$(docker image inspect --format \'{{.Id}}\' weft:validated)" = "$IMAGE_ID"',
    );
    expect(publication.indexOf("sha256sum --check")).toBeLessThan(
      publication.indexOf("docker login"),
    );
    expect(publication.indexOf("docker login")).toBeLessThan(publication.indexOf("docker push"));
    expect(publication).toContain('docker push "ghcr.io/cludewn/weft:$IMAGE_TAG"');
    expect(verification).toContain(
      "org.opencontainers.image.source=https://github.com/cludewn/WEFT",
    );
    expect(verification).toContain("org.opencontainers.image.revision=$SOURCE_SHA");
    const probe = readFileSync(join(root, "scripts/verify-image.sh"), "utf8");
    expect(probe).toContain("--network none --read-only --cap-drop ALL");
    expect(probe).toContain('["--check", entry]');
    expect(probe).not.toContain('import("');
  });
});

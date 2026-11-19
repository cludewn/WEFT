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

describe("registry tag check before publication", () => {
  type Reply = {
    status?: number;
    body?: unknown;
    raw?: string;
    failure?: "network" | "timeout" | "truncated";
  };
  const missing = { status: 404, body: { errors: [{ code: "MANIFEST_UNKNOWN" }] } };
  const token = { status: 200, body: { token: "fixture-bearer-token" } };
  const publishRun = publication
    .split("      - name: Authenticate with the job token and publish the verified image\n")[1]!
    .split("        run: |\n")[1]!
    .replace(/^ {10}/gm, "");

  function check(manifest: Reply = missing, tokenReply: Reply = token, script = publishRun) {
    const { directory, bin, path } = fixture();
    const calls = join(directory, "calls");
    writeFileSync(calls, "");
    writeFileSync(
      join(directory, "responses.json"),
      JSON.stringify({ token: tokenReply, manifest }),
    );
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1" in
  login) cat >/dev/null ;;
  logout|push) ;;
  manifest) exit 1 ;;
  image) echo '[]' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "python3"), '#!/bin/sh\nexec /usr/bin/python3 "$REGISTRY_FIXTURE"\n', {
      mode: 0o700,
    });
    // Replace only HTTP I/O; execute the workflow's actual Python and shell code.
    // A bootstrap failure exits Python before the workflow code can make a request.
    writeFileSync(
      join(directory, "registry.py"),
      `import base64, io, json, os, sys
from http.client import IncompleteRead
from urllib.error import HTTPError, URLError
from urllib.request import OpenerDirector

with open("responses.json") as file:
    replies = json.load(file)

class Response(io.BytesIO):
    code = 200

def fake_open(self, request, timeout):
    assert timeout == 30
    url = request.full_url
    if url == "https://ghcr.io/token?service=ghcr.io&scope=repository:cludewn/weft:pull":
        kind = "token"
        basic = base64.b64encode(b"fixture-actor:fixture-job-token").decode()
        assert request.get_header("Authorization") == "Basic " + basic
        assert request.get_header("Accept") == "application/json"
    elif url == "https://ghcr.io/v2/cludewn/weft/manifests/v1.0.0":
        kind = "manifest"
        assert request.get_header("Authorization") == "Bearer fixture-bearer-token"
        assert "application/vnd.oci.image.index.v1+json" in request.get_header("Accept")
        assert "application/vnd.docker.distribution.manifest.list.v2+json" in request.get_header("Accept")
    else:
        raise AssertionError("Unexpected registry URL")
    with open(os.environ["FIXTURE_CALLS"], "a") as file:
        file.write("registry " + kind + "\\n")
    reply = replies[kind]
    failure = reply.get("failure")
    if failure == "network":
        raise URLError("fixture-bearer-token")
    if failure == "timeout":
        raise TimeoutError("fixture-bearer-token")
    if failure == "truncated":
        raise IncompleteRead(b"fixture-bearer-token")
    body = reply.get("raw", json.dumps(reply.get("body"))).encode()
    status = reply.get("status", 200)
    if status != 200:
        raise HTTPError(url, status, "fixture-bearer-token", {}, io.BytesIO(body))
    return Response(body)

OpenerDirector.open = fake_open
exec(compile(sys.stdin.read(), "workflow-publication", "exec"))
`,
    );
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: path,
          IMAGE_TAG: "v1.0.0",
          SOURCE_SHA: sha,
          IMAGE_ID: `sha256:${"b".repeat(64)}`,
          GITHUB_ACTOR: "fixture-actor",
          GHCR_TOKEN: "fixture-job-token",
          DOCKER_CONFIG: join(directory, "docker-auth"),
          GITHUB_STEP_SUMMARY: join(directory, "summary"),
          FIXTURE_CALLS: calls,
          REGISTRY_FIXTURE: join(directory, "registry.py"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).not.toMatch(/fixture-(?:bearer|job)-token/);
    return { result, calls: readFileSync(calls, "utf8") };
  }

  it("demonstrates that the applied CLI suggestion proceeds after an ambiguous inspection failure", () => {
    const { result, calls } = check(
      missing,
      token,
      `
if docker manifest inspect "ghcr.io/cludewn/weft:$IMAGE_TAG" >/dev/null 2>&1; then
  exit 1
fi
docker push "ghcr.io/cludewn/weft:$IMAGE_TAG"
`,
    );
    expect(result.status).toBe(0);
    expect(calls).toContain("push ghcr.io/cludewn/weft:v1.0.0");
  });

  it("pushes only after an authenticated, explicit manifest-not-found response", () => {
    const { result, calls } = check();
    expect(result.status, result.stderr).toBe(0);
    expect(calls.indexOf("registry token")).toBeLessThan(calls.indexOf("registry manifest"));
    expect(calls.indexOf("registry manifest")).toBeLessThan(calls.indexOf("push "));
    expect(calls).toContain("push ghcr.io/cludewn/weft:v1.0.0");
    expect(calls).toContain("logout ghcr.io");
  });

  it.each([
    { status: 200, body: {} },
    { status: 401, body: { errors: [{ code: "UNAUTHORIZED" }] } },
    { status: 403, body: { errors: [{ code: "DENIED" }] } },
    { status: 404, body: { errors: [{ code: "NAME_UNKNOWN" }] } },
    { status: 404, body: { errors: [{ code: "MANIFEST_UNKNOWN" }, { code: "DENIED" }] } },
    { status: 404, body: { errors: [] } },
    { status: 404, body: { errors: [null] } },
    { status: 404, body: { errors: "MANIFEST_UNKNOWN" } },
    { status: 404, body: [] },
    { status: 404, raw: "<html>Not found</html>" },
    { status: 404, raw: "x".repeat(65537) },
    { status: 302, body: missing.body },
    { status: 429, body: missing.body },
    { status: 500, body: missing.body },
    { failure: "network" },
    { failure: "timeout" },
    { failure: "truncated" },
  ] satisfies Reply[])("stops without pushing for manifest response %#", (reply) => {
    const { result, calls } = check(reply);
    expect(result.status).toBe(1);
    expect(calls).toContain("registry manifest");
    expect(calls).not.toContain("push ");
    expect(calls).toContain("logout ghcr.io");
  });

  it.each([
    { status: 401 },
    { status: 403 },
    { status: 404, body: missing.body },
    { status: 500 },
    { status: 302 },
    { status: 200, raw: "not JSON" },
    { status: 200, body: {} },
    { status: 200, body: { token: "" } },
    { status: 200, body: { token: 1 } },
    { status: 200, body: { token: "invalid\ntoken" } },
    { failure: "network" },
    { failure: "timeout" },
  ] satisfies Reply[])(
    "stops before inspecting or pushing when token acquisition fails: %#",
    (reply) => {
      const { result, calls } = check(missing, reply);
      expect(result.status).toBe(1);
      expect(calls).not.toMatch(/registry manifest|push /);
      expect(calls).toContain("logout ghcr.io");
    },
  );
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
    expect(publication).toContain('stop("Version tag already exists; refusing to overwrite it.")');
    expect(publication).toContain('error.get("code") != "MANIFEST_UNKNOWN"');
    expect(publication).toContain("build_opener(NoRedirect())");
    expect(publication.indexOf("python3 - <<'PY'")).toBeLessThan(
      publication.indexOf("docker push"),
    );
    expect(workflow).toContain(
      "group: weft-image-${{ github.event.release.tag_name || github.ref }}",
    );
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

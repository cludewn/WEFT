#!/usr/bin/env bash
set -euo pipefail

image=${1:?Pass a local image reference}

# Inspect metadata and parse files only. Never import or execute application entrypoints.
docker image inspect "$image" | node --input-type=module -e '
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [image] = JSON.parse(readFileSync(0, "utf8"));
assert.equal(image.Config.User, "node");
assert.equal(image.Config.WorkingDir, "/app");
assert.deepEqual(image.Config.Cmd, ["node", "dist/index.js"]);
'

docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
assert.equal(process.versions.node.split(".")[0], "24");
for (const entry of ["dist/index.js", "dist/migrate.js", "dist/deploy-commands.js"]) {
  accessSync(entry, constants.R_OK);
  execFileSync(process.execPath, ["--check", entry], { stdio: "inherit" });
}
console.log("Node.js 24 and all three runtime entrypoints verified without application execution.");
'

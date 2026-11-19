#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_EVENT_NAME:-}" != release || "${GITHUB_REPOSITORY:-}" != cludewn/WEFT ]]; then
  echo "Release publication requires the upstream repository's release event." >&2
  exit 1
fi

tag=${RELEASE_TAG:-}
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ || "$tag" == v0.9.0 ]]; then
  echo "A stable vX.Y.Z release tag other than v0.9.0 is required." >&2
  exit 1
fi

test "${GITHUB_REF:-}" = "refs/tags/$tag"
version=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync("package.json", "utf8")).version)')
if [[ "$tag" != "v$version" ]]; then
  echo "Release tag does not match package.json version." >&2
  exit 1
fi

head_sha=$(git rev-parse HEAD)
tag_sha=$(git rev-parse --verify "refs/tags/$tag^{commit}")
test "$head_sha" = "${GITHUB_SHA:-}"
test "$tag_sha" = "$head_sha"
if ! git merge-base --is-ancestor "$head_sha" refs/remotes/origin/main; then
  echo "Release commit must already be included in main." >&2
  exit 1
fi

echo "tag=$tag" >> "$GITHUB_OUTPUT"

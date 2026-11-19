# GHCR image publication

Issue #163 adds distribution infrastructure for `ghcr.io/cludewn/weft`. It does not publish an
image by itself or change the existing source-build Compose installation. Image availability and
public visibility remain unverified until the first approved release is actually published.

## Trigger and release prerequisites

The `Container image` workflow builds the existing production Dockerfile for PRs targeting `main`.
PR jobs have only `contents: read`, never authenticate to GHCR, and never upload a release image.
Ordinary branch pushes and tag pushes do not start this workflow.

Publication starts only on `release: published` in `cludewn/WEFT`. Publishing a stable GitHub Release
is the maintainer's approval to distribute that tag. Drafts and prereleases cannot publish images.
There is no additional environment approval gate. Before approving a release:

- Merge and review the workflow, including the independent CodeRabbit PR review required by
  Issue #163. Require passing repository CI, including PostgreSQL integration tests.
- Ensure the release commit includes the workflow and is already reachable from `main`.
- Use a stable `vX.Y.Z` tag with no leading zeroes. It must exactly equal `v` plus that commit's
  `package.json` version. The event SHA, checked-out commit, and resolved tag must agree.
- Do not reuse or move published release tags. Protect release tags and restrict Release publishing
  to trusted maintainers through repository rules and permissions.
- Verify Actions are allowed to publish packages. A pre-existing GHCR package may need its Actions
  repository access configured. Do not add a personal access token to work around missing access.

`v0.9.0` is explicitly rejected, including if its existing Release is republished. There is no
retroactive publication, version bump, new release, or `latest` alias in this change. The only
registry tag written by a successful release run is its exact version, for example `:vX.Y.Z`.

The Release event was chosen over tag push because tag creation alone need not mean approval to
distribute an image. GitHub's `published` event also handles publication from a saved draft;
the workflow separately excludes prereleases. Tag-push workflows can publish too early and do
not receive an event when more than three tags are pushed at once. See GitHub's
[event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

## Validation and permission boundary

The read-only verification job checks the release version and `main` ancestry, runs standard
format/lint/type/unit/build checks for releases, and builds the Node.js 24 runtime image. PRs run
the image build and probe; the existing CI workflow runs their standard checks.

The offline probe checks `USER node`, the working directory, the default application command,
Node.js 24, and readable, syntactically valid `dist/index.js`, `dist/migrate.js`, and
`dist/deploy-commands.js`. It overrides the entrypoint, disables networking, and never imports or
executes those files. It needs no Discord or database credentials. This is an artifact smoke check,
not proof of application startup, dependency resolution, migration success, or Discord registration.

Only a successful release verification uploads an image archive. A separate job with only
`packages: write` downloads that exact artifact ID from the same run, checks the archive SHA-256,
image ID, and OCI source/revision/version labels, then tags and pushes the already verified image.
It does not check out source, install dependencies, build again, or run a container. PR artifacts
cannot reach this job. Any earlier step failure prevents login and push. A registry/network failure
during push can leave uploaded blobs or an already accepted manifest even if the job reports failure;
publication is not a transaction with the workflow or GitHub Release.

After Docker login, the publisher uses Python 3's standard library on the Ubuntu runner to request
a repository-scoped pull token and GET the exact tag's manifest from GHCR over HTTPS. Only HTTP 404
with a nonempty JSON `errors` array containing exclusively `MANIFEST_UNKNOWN` permits the push.
HTTP 200 blocks an existing tag. Token acquisition errors, HTTP 401/403, timeouts, transport errors,
redirects, rate limits, server errors, malformed responses, and other error codes all stop publication.
Requests use a 30-second socket timeout and a bounded response size; raw responses and credentials are not
logged. `docker manifest inspect` failure alone cannot distinguish these cases from tag absence.
The response interpretation follows the OCI Distribution Specification's
[manifest endpoint and error codes](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md).

This is a conservative check, not a claim that every GHCR failure can be classified. In particular,
`NAME_UNKNOWN`, an unstructured 404, or denial when the package has never been created does not
establish tag absence for this workflow. Such a first publication stops for investigation of registry
access and response semantics. Do not bypass the check or add credentials to force it through.

The existing per-tag concurrency group serializes runs of this workflow for the same release tag.
It does not lock GHCR or other writers. There is still a check-to-push (TOCTOU) window: another writer
outside that concurrency group can publish after the check and before this push. No registry-side
atomic create-if-absent operation is used, so this guard does not guarantee complete tag immutability.
Restrict registry writers and retain digest references; do not describe the preflight as an atomic lock.

Authentication uses the job's short-lived `GITHUB_TOKEN` over `--password-stdin` with a temporary
Docker configuration, removed on exit. No long-lived registry secret is needed. Actions are pinned
to full commit SHAs. Their official release tags and action manifests were checked for these pins:

- `actions/checkout` v7.0.1: `3d3c42e5aac5ba805825da76410c181273ba90b1`
- `actions/setup-node` v6.5.0: `249970729cb0ef3589644e2896645e5dc5ba9c38`
- `actions/upload-artifact` v6.0.0: `b7c566a772e6b6bfb58ed0dc250532a479d7789f`
- `actions/download-artifact` v7.0.0: `37930b1c2abaa49bbe596cd826c3c89aef350131`

## Inspecting the image and its origin

For local validation, without starting the application or reading an environment file:

```sh
docker build --target runtime -t weft:image-check .
bash scripts/verify-image.sh weft:image-check
```

After an approved release actually succeeds, substitute its exact tag for `vX.Y.Z`:

```sh
docker buildx imagetools inspect ghcr.io/cludewn/weft:vX.Y.Z
docker pull ghcr.io/cludewn/weft:vX.Y.Z
docker image inspect ghcr.io/cludewn/weft:vX.Y.Z --format '{{json .RepoDigests}} {{json .Config.Labels}}'
bash scripts/verify-image.sh ghcr.io/cludewn/weft:vX.Y.Z
```

Compare the registry digest with the successful publication run's summary. Check
`org.opencontainers.image.source=https://github.com/cludewn/WEFT`, the revision against the release
tag's commit and run summary, and the version against the tag and `package.json`. The source label
links the GHCR package to this repository. OCI labels and run records describe origin; they are not
cryptographic provenance attestations. No signing or OIDC/attestation permissions are introduced.
Use the recorded `ghcr.io/cludewn/weft@sha256:...` reference when an immutable image identity is needed;
version tags can still be overwritten by an authorized registry writer.

The initial workflow builds only `linux/amd64` on the GitHub-hosted Ubuntu runner. Base image tags
remain as specified by the existing Dockerfile; rebuilding the same source can change the image.

## Failure and first-publication checks

A GitHub Release can be visible before its image finishes building or even when publication fails.
Do not announce image availability until the run succeeds and the registry is checked. Release edits,
ordinary pushes, and promoting an already published prerelease do not trigger this workflow again.
After diagnosing a failure, inspect the exact version's registry state and digest before deciding
whether a retry is needed. An existing tag stops a rerun, including when the previous push succeeded
but a later summary step failed. Verify that existing image against the release and preserve its
digest; do not delete the published tag or republish it as routine recovery. If the published image
is wrong, prepare a corrected version through the normal review process.

When absence is explicitly confirmed, rerun the original failed workflow; if the one-day image
artifact has expired, rerun all jobs. Rerunning all jobs rebuilds, but publication still requires
the same absence check. Authentication, transport, or unexpected-response failures require diagnosis
and a new check; they are never permission to push. A failure during push leaves the outcome uncertain
until the registry is inspected. Do not move a release tag to repair a version mismatch.

This protection applies to runs whose release commit contains this guard. A rerun retains the
original event's SHA and ref; later workflow changes do not retrofit earlier runs. Do not retry an
older unguarded publication run as a recovery shortcut. See GitHub's
[rerun behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

During the first authorized publication, separately verify package repository association, package
visibility, anonymous pull if intended to be public, the digest and labels, and the offline probe.
New GHCR packages can default to private. This workflow does not change visibility settings.
Actual GHCR publication and these checks are deliberately outside Issue #163 implementation.

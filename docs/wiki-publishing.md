# Wiki publishing

Issue #127 maintains canonical user documentation in `docs/wiki/`. English is canonical; Japanese
must give equivalent practical instructions. The GitHub Wiki is a one-way publication target.
Edit repository sources through review, never the published pages. This documentation describes
the unreleased development MVP, not a production-ready release.

## Maintainer setup and acceptance boundary

Before the first intended publication:

1. Enable Wiki in the WEFT repository settings and restrict editing to appropriate collaborators.
2. Create a nonempty Markdown Home page through GitHub so that the Wiki Git repository exists.
   On first publication the destination must contain **only `Home.md`**. This seed is intentionally
   replaced by canonical Home, preserving the existing Git commit/history. Migrate any other
   useful pages into reviewed sources, and handle the originals explicitly before trying again.
3. Permit this dedicated job's `GITHUB_TOKEN` request for `contents: write` under repository and
   organization policies. No PAT, GitHub App secret, deploy key or broader permission is configured.
4. After merging to `main`, run **Publish Wiki** from `main`, observe the real push, and record
   acceptance. Wiki push authorization with `GITHUB_TOKEN` is an **unverified initial candidate**
   until this actually succeeds. Local fixtures do not establish that capability.

If authentication fails, keep the failed run visible, distinguish initialization, access policy,
remote URL and network problems, and reassess authentication with the maintainer. Do not silently
introduce another credential. A clone failure alone does not prove the Wiki is uninitialized.

Only local Git fixtures are used during implementation. They create commits and pushes exclusively
inside disposable local repositories, never in the WEFT checkout or on GitHub.

## Source and navigation contract

Each content page has `Page.md` and `Page-ja.md`, with Home as each language's entry point. A single
`_Sidebar.md` groups both languages into setup, feature, operations and command sections. Every page
links its language counterpart, Home, command index and troubleshooting. Topic pages link the detailed
command references. Wiki links omit `.md`; Japanese topic headings also expose stable explicit ASCII
anchors corresponding to the English topics. Command headings use their complete command paths.

Sources are a flat set of nonempty UTF-8 regular Markdown files with bounded size/count. Stable
ASCII page names start with an uppercase letter and contain only alphanumerics and hyphens; `_Sidebar`
is the one special page. Traversal, case collisions, subdirectories, symlinks, unexpected extensions,
empty sets/files, invalid UTF-8 and NUL bytes fail validation. No generated page from outside
`docs/wiki/` is published. The local personal Wiki backlog stays ignored and is never a publication
input.

The validator checks required topics, pairs, language switches, every sidebar target, inline internal
links/anchors, all registered command sections/index entries, required/optional options, types,
choices, registered string lengths/channel kinds, obsolete syntax, named audit sources and selected
critical numeric facts against exported implementation constants. Fact comments identify a visible
table row to check; they are not alternative unpublished values. It rejects reference-style links
and Wiki-specific `[[...]]` syntax so link validation has one explicit supported form. Use inline
Markdown links. Translation equivalence, permissions, certainty and prose accuracy still need human
review; passing structural checks is not semantic approval.

## Workflow and immutable revision

`.github/workflows/wiki.yml` is independent of existing CI and PostgreSQL integration. Existing CI
also discovers the Wiki unit tests through the normal `pnpm test` command. The dedicated workflow
runs for relevant pushes to `main`, and manual dispatch; a non-main dispatch is skipped by the job
guard and independently refused by the publication CLI. There is no PR publication trigger.

The workflow uses SHA-pinned checkout/setup-node Actions, Node.js 24 and frozen pnpm dependencies.
It checks out current main with full history and no persisted credentials, fetches authoritative
`refs/heads/main` again, resolves its exact SHA and checks out that detached revision. This means an
old run/re-run executes the current main publisher and current sources rather than its old event
`GITHUB_SHA`. Full history supports ancestry checks. The resolved SHA is recorded in the run summary.
The source checkout and every source page must exactly match that Git tree before synchronization;
uncommitted/untracked source changes cannot be published.

All publications share `weft-wiki-publication` with `cancel-in-progress: false`. An active push is
not cancelled to replace it. Pending-run ordering is not treated as authority. The publisher checks
the remote main SHA both before synchronization and immediately before push; if main advanced,
it fails and requires a fresh run. It also requires the last recorded published source SHA to be an
ancestor of the selected SHA. A previously published newer/divergent revision cannot be overwritten
by an old source even under an incorrectly stale main observation. There is no source rewind,
force push, mirror or timestamp/run-ID ordering rule.

There is no cross-repository atomic transaction: main can advance just after the final freshness
observation. That run may briefly publish the revision just verified, but cannot roll back a newer
publication made through this serialized publisher. The later run resolves latest main. A main
history rewrite or missing ancestry fails closed and needs investigation, not automatic override.

## Authentication boundary

The job requests `contents: write`; workflow-level permission is `contents: read`. The token is
provided only to the main-resolution and publication steps, not dependency installation or tests.
`scripts/wiki/askpass.sh` supplies it to Git through the askpass protocol. Remote URLs contain no
credentials, checkout does not persist credentials, and Git credential helpers/global config/hooks
and verbose transport traces are disabled at the publisher boundary. The temporary clone and
working tree are removed afterward. Never enable shell tracing, Git tracing or dump the environment.
The publisher logs only fixed result/error codes and validated revisions, not raw Git stderr.

The CLI constructs the repository and Wiki HTTPS URLs from the validated GitHub repository identity;
it accepts only `push` or `workflow_dispatch` on `refs/heads/main`. It is an Actions entrypoint, not
a supported local command to publish arbitrary refs. Do not use it to perform pre-merge acceptance.

## Managed pages and deletion evidence

The Wiki Git root includes `.weft-wiki-manifest.json`, an operational metadata file rather than a
user page. Version 1 stores the source repository identity, source commit SHA and a deterministic
ordered list of managed page paths with SHA-256 hashes. This file and its Git history preserve
the evidence for **previously managed pages**, including deletion/rename decisions. It is generated
from validated canonical Markdown and is not a second content source.

Before checking out destination files, the publisher inspects the Git tree and rejects non-regular
file modes, symlinks, nested paths and unexpected entries. After bootstrap, the destination tree
must equal the prior manifest plus exactly its listed pages. Every listed page must still match
its recorded hash. Missing pages, direct edits, unknown pages, invalid manifests or a different
repository identity stop synchronization without deleting/overwriting them.

It then updates/adds current pages and removes only paths listed by the prior manifest that no
longer exist in the validated source set. A rename is an addition plus removal of the old managed
path. The next manifest records the resulting ownership and hashes. `_Sidebar.md` is managed in the
same way. The actual remote Wiki HEAD symbolic reference is discovered; neither `main` nor `master`
is assumed. A missing/unconfirmed default branch is a failure.

No changed page/hash set means a confirmed no-op: no commit or push, even if unrelated source commits
advanced main. The manifest continues to name the revision that supplied the unchanged content;
the run summary separately names requested latest main and recorded content source.

## Push conflicts, confirmation and observability

Immediately before publishing, the publisher confirms both main freshness and the unchanged Wiki
default branch/HEAD. It pushes one normal fast-forward commit onto that branch. A concurrent Wiki
change before the check fails explicitly; a race after the check is still protected by normal Git
non-fast-forward rejection. It never force-pushes, merges unknown pages, retries the mutation blindly
or silently resets destination history.

Every push, including a command reporting success, is followed by a fresh remote HEAD observation.
Only an exact match with the proposed Wiki revision confirms publication. A lost/failed push response
can still be classified as success **only** when that exact revision is positively observed. If the
remote remains unchanged after rejection, the result is `PUSH_FAILED`; an unreadable or different
result is `PUSH_RESULT_UNCONFIRMED`. Both fail the workflow. A different HEAD might include external
changes, so this deliberately prefers an observable failure to guessed success.

Success/no-op summaries name the source revision, recorded content source and confirmed Wiki revision.
Publication errors emit a bounded error code and nonzero exit. If validation, setup or any earlier
step fails, the final summary still says publication did not complete successfully. A timeout or
runner failure can also interrupt the post-push confirmation; check remote state before repeating.

## Diagnose and recover

1. Inspect the failed step and summary. Keep the original failure visible. A generic Git failure
   can be authentication, initialization, configuration, connectivity or an unavailable remote.
   Use trusted read-only inspection without printing tokens, credential-bearing URLs or raw config.
2. For stale-source/default-branch conflicts, inspect current main and Wiki history, then manually
   dispatch the workflow **on main**. A rerun also resolves latest main; it does not replay old content.
3. For unmanaged/directly edited content, preserve it in a private backup or reviewed repository
   source first. Compare it against canonical Markdown and the recorded manifest. Restore the
   destination's prior managed snapshot with a normal reviewed Wiki commit if appropriate; handle
   additional pages explicitly with the maintainer. Do not delete unknown pages automatically, edit
   hashes to bless unexplained drift, remove the manifest to bypass checks, or force-reset history.
4. For an unconfirmed push, inspect the remote default branch and exact proposed revision/source
   from the run/history. Do not assume either success or nonpublication. After resolving the cause,
   dispatch main again: a matching published snapshot becomes a no-op, an unchanged target gets a
   fresh synchronization, and unexplained content conflicts still stop safely.
5. For source validation failures, fix canonical sources and their translations through review,
   rerun local checks, then merge. Never bypass the gate to repair the Wiki directly.
6. If token capability is unsupported, stop and report that fact. Alternative authentication needs
   an explicit approved design; it is not a secret to add opportunistically.

## Verification and staged acceptance

Run with Node.js 24, without a real environment file or external services:

```sh
corepack pnpm wiki:check
corepack pnpm exec vitest run test/unit/wiki-content.test.ts test/unit/wiki-publish.test.ts test/unit/wiki-workflow.test.ts
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

If the real checkout contains secret environment files, use a clean snapshot excluding all such
files and the personal backlog before invoking Vite/Vitest (which can discover environment files).
Local Git fixtures cover Home adoption, alternate default branches, additions/updates, deletion/rename,
no-op, empty/unsafe sources, direct/unmanaged content, destination conflicts, old source/run ordering,
source advancement, rejection, response loss, unconfirmed push and fresh resynchronization.
Validate YAML and run actionlint against the new workflow when available. Never connect to a real
DB, Docker, Discord or the GitHub Wiki to run these fixtures.

Before commit/merge, an independent read-only final reviewer must still approve the implementation
and semantic bilingual coverage. Local passing checks do not replace that review.

Post-merge maintainer acceptance must record:

- Wiki enabled, initialized and access restricted as intended;
- actual successful push with the selected authentication mechanism and confirmed source/Wiki SHAs;
- published Home/Home-ja, bilingual sidebar, language switches, topic links and representative anchors;
- current-main content and repeat/no-op behavior;
- recovery after a controlled publication failure, followed by confirmed current-main resynchronization;
- any operational follow-up or authentication decision.

Use `Refs #127` in the implementation PR. Do not close Issue #127 until real publication acceptance
is completed and recorded. Implementation-only work establishes neither authentication success nor
real Wiki rendering/acceptance.

Official operational references: [GitHub Wiki editing and initialization](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages),
[workflow concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency),
and [GITHUB_TOKEN scope](https://docs.github.com/en/actions/concepts/security/github_token).

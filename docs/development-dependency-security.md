# Development dependency security review (Issue #138)

Reviewed on 2026-10-22 against main `2d4577469efdf26d2adaf1ca1e49a12b74b88f96`.
Scope: [Issue #138](https://github.com/cludewn/WEFT/issues/138).
This is an implementation and verification record, not a product specification change.

## Changes

- Raise the direct Vitest development dependency from `^4.1.11` to `^4.1.12`.
- Refresh the affected transitive development resolutions in `pnpm-lock.yaml`.
- Override only `@esbuild-kit/core-utils@3.3.2>esbuild` to `0.25.12` in
  `pnpm-workspace.yaml`. No other permanent override is introduced.
- Preserve all production resolutions, all other direct dependencies, Node.js 24 and pnpm 11.20.0.

No application source, schema, migration, Dockerfile, workflow, Dependabot configuration, or
approved specification changes. No dependency is added to or removed from the manifest.

## Advisory verification

The initial full `corepack pnpm audit --json` reported **14** advisories, rather than the 11 in
the Issue: two additional brace-expansion advisories and one nanoid advisory also affect the
existing development graph. The table links to the official GitHub advisory records. Their
affected ranges and first patched versions were checked through GitHub's advisory API on the
review date, separately from npm audit. All selected versions are outside every affected range
for their package in these records.

| Package                      | Advisory                                                                 | Affected installed release line | First patched version | Selected version |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------- | --------------------- | ---------------- |
| vite                         | [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| vite                         | [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| vite                         | [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| vite                         | [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| vite                         | [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| vite                         | [GHSA-vfpm-58rq-9qcg](https://github.com/advisories/GHSA-vfpm-58rq-9qcg) | >=8.2.0 <=8.2.3                 | 8.2.4                 | 8.2.4            |
| @vitest/mocker               | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) | >=2.1.0-beta.7 <4.1.12          | 4.1.12                | 4.1.12           |
| @vitest/mocker               | [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) | >=4.1.11 <4.1.12                | 4.1.12                | 4.1.12           |
| source-map-js                | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | >=1.0.0 <1.2.2                  | 1.2.2                 | 1.2.2            |
| brace-expansion              | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | >=4.0.0 <5.0.12                 | 5.0.12                | 5.0.12           |
| esbuild                      | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | <=0.24.2                        | 0.25.0                | 0.25.12          |
| brace-expansion (additional) | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | >=4.0.0 <5.0.11                 | 5.0.11                | 5.0.12           |
| brace-expansion (additional) | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | >=4.0.0 <5.0.10                 | 5.0.10                | 5.0.12           |
| nanoid (additional)          | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | <3.3.18                         | 3.3.18                | 3.3.18           |

The npm audit response describes esbuild's patched range as `>=0.24.3`, whereas GitHub's official
record identifies `0.25.0` as the first patched release. The selected `0.25.12` satisfies both.
Audit results are a dated observation of known advisories, not a guarantee against future findings.

## Dependency paths, constraints, and duplicates

All affected packages are **transitive development dependencies**. Vitest, ESLint,
typescript-eslint, and Drizzle Kit are direct development dependencies. None of the affected
packages is in the production dependency graph.

| Package                   | All owning paths (shared peer paths are expanded below)                                                                                                           | Parent constraint                                                                 | Before -> after                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| vite                      | vitest -> vite; vitest -> @vitest/mocker -> vite (optional peer)                                                                                                  | Both accept `^6.0.0                                                               |                                      | ^7.0.0   |                  | ^8.0.0` | 8.2.0 -> 8.2.4 |
| @vitest/mocker            | vitest -> @vitest/mocker                                                                                                                                          | Exact `4.1.11` -> exact `4.1.12`                                                  | 4.1.11 -> 4.1.12                     |
| source-map-js             | Both Vite paths above -> postcss -> source-map-js                                                                                                                 | PostCSS `^1.2.1`                                                                  | 1.2.1 -> 1.2.2                       |
| nanoid                    | Both Vite paths above -> postcss -> nanoid                                                                                                                        | PostCSS 8.5.25: `^3.3.16`; 8.5.26: `^3.3.17`                                      | 3.3.17 -> 3.3.18                     |
| brace-expansion           | eslint -> minimatch; eslint -> @eslint/config-array -> minimatch; typescript-eslint -> @typescript-eslint/typescript-estree -> minimatch; each -> brace-expansion | minimatch 10.2.6: `^5.0.8`                                                        | 5.0.9 -> 5.0.12                      |
| esbuild (vulnerable)      | drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild                                                                                      | Kit: loader `^2.5.5`; loader: core-utils `^3.3.2`; core-utils: esbuild `~0.18.20` | 0.18.20 -> 0.25.12 (scoped override) |
| esbuild (already patched) | drizzle-kit -> esbuild                                                                                                                                            | `^0.25.4`                                                                         | 0.25.12 unchanged                    |
| esbuild (already patched) | tsx -> esbuild; Vite's optional esbuild peer                                                                                                                      | tsx: `~0.28.0`; Vite: `^0.27.0                                                    |                                      | ^0.28.0` | 0.28.1 unchanged |

For completeness, the ESLint paths include its peer consumers: `@eslint/js`, typescript-eslint,
`@typescript-eslint/eslint-plugin`, `parser`, `type-utils`, `utils`, and
`@eslint-community/eslint-utils`. `@eslint/config-array@0.23.5` requests minimatch `^10.2.4`;
`eslint@10.8.0` requests `^10.2.5`. The typescript-estree paths are through typescript-eslint's
parser, type-utils, and utils (including the eslint-plugin's use of those packages), all at 8.66.0;
typescript-estree requests minimatch `^10.2.2`. Peer reuse does not create another installed
minimatch or brace-expansion version. `pnpm why` and the full `pnpm list --depth Infinity --json`
graph were inspected to include these shared routes.

tsx is reached directly from WEFT, from drizzle-kit (`^4.21.0`), and through Vite's optional peer
(`^4.8.1`). All use the unchanged 4.23.6 release.

Each affected package has one installed version after the change, except esbuild, which decreases
from three versions to two: `0.25.12` and `0.28.1`. The vulnerable old versions are absent from
the final lockfile and a fresh installed virtual store, including esbuild's 0.18.20 platform packages.

## Minimal update selection and automatic-update limits

Vitest's exact internal package versions require updating the parent to keep its mocker, expect,
runner, snapshot, spy, utils and pretty-format packages aligned at 4.1.12. A mocker-only override
would break that alignment. The Vitest 5 major upgrade is unnecessary.

Vite 8.2.4 is the patched release on the existing 8.2 line. Its published manifest requires
PostCSS `^8.5.26` and Rolldown `~1.2.4`, so the old 8.5.25 and 1.2.2 cannot be retained. The lockfile
uses 8.5.26 and 1.2.4; Rolldown requires `@oxc-project/types=0.144.0` and matching native bindings.
These accompanying changes are required by Vite's patched manifest. No Vite 8.3 upgrade is needed.
source-map-js, brace-expansion, and nanoid patches satisfy their existing parent ranges.

The compatible transitive resolutions were selected temporarily during lockfile generation;
those temporary overrides were removed. Only the esbuild override remains in configuration and
the lockfile. Unrelated picomatch deduplication from the resolver was reverted to preserve the
existing graph. Frozen installs validate the final references and manifest consistency.

The dependency constraints explain two actual resolver blockers: Vitest pins mocker exactly,
and core-utils excludes every patched esbuild release. The source-map-js, brace-expansion, and
Vite parent ranges permit patched releases; their locked versions need a refresh. The precise
Dependabot job failure diagnostics were not available through the inspected Issue/PR data.
These resolver findings must not be presented as verified explanations of every GitHub job
failure. No alert was dismissed and no remote Issue or PR was modified.

## Drizzle Kit and esbuild compatibility decision

The registry's latest stable drizzle-kit, 0.31.11, still declares the same old loader dependency
as 0.31.10. The latest loader and core-utils releases remain 2.6.5 and 3.3.2, both deprecated.
Updating Drizzle Kit alone therefore does not remove esbuild 0.18.20. A prerelease Drizzle Kit/ORM
migration would exceed this security task's scope and risk changing migration behavior.

The chosen override targets one parent **and version**, rather than replacing esbuild throughout
the graph. It reuses the existing Drizzle Kit esbuild 0.25.12 installation. Vite and tsx retain
0.28.1, which satisfies their different ranges. This crosses core-utils' declared compatibility
range and is an explicit, tested exception, not an upstream compatibility guarantee.

Source inspection showed core-utils uses esbuild's `transform`, `transformSync`, and `version`,
not its development server. The [upstream 0.25.0 release](https://github.com/evanw/esbuild/releases/tag/v0.25.0)
documents breaking development-server access changes; those are not used by this loader.
The [esbuild transformation API](https://esbuild.github.io/api/#transform) remains available.
No third-party implementation was copied into this repository.

Compatibility evidence on Node 24:

- Resolve esbuild from the actual loader/core-utils boundary and assert version 0.25.12.
- Execute core-utils synchronous CommonJS and asynchronous ESM TypeScript enum transforms and
  evaluate their output; verify source maps are returned.
- Register the actual legacy ESM loader using `node:module.register`; run TypeScript enum code
  with static and dynamic imports in an ESM fixture. This also exercises the otherwise unused
  legacy dependency, rather than assuming Drizzle's modern tsx path covers it.
- Run `db:check` against committed migration history.
- Run `db:generate` in a disposable full source copy: no schema changes, no migration generated,
  and all SQL, snapshots and journal bytes unchanged.
- Confirm `drizzle-kit check` rejects a copied snapshot history with a parent collision, exit 1.
  Committed snapshots were never changed for this negative check.
- Run all 689 PostgreSQL integration tests, including migration and production migration suites.

Alternatives: retain the vulnerable package while disabling server use (does not resolve the
alert); globally override esbuild (unnecessary range violations); replace the deprecated loader
with tsx by package alias (different public API); or adopt prerelease Drizzle tooling (broader
toolchain and ORM compatibility work). The narrow override has the smallest tested impact.
Remove it when a stable parent chain no longer needs the vulnerable version, then rerun loader,
migration, full integration, audit and Docker checks. Its fixed version also needs normal future
security monitoring. Platforms beyond the verified Linux environment were not executed.

The direct legacy-loader probe emits Node 24's `globalPreload` removal warning. That hook is
exported by the unchanged deprecated loader; Drizzle's normal configuration path uses tsx and
does not emit it. The probe's TypeScript execution completes successfully, including its explicit
completion marker, and the transform APIs return source maps. This does not establish support
for every legacy-loader hook on Node 24. No warning was suppressed or loader behavior rewritten.

## PR #135 coordination

[PR #135](https://github.com/cludewn/WEFT/pull/135), head
`97d5173c9f2753e29716fd65a403a70031eae6fa`, updates drizzle-kit from 0.31.10 to 0.31.11.
Its lockfile also changes development resolutions including tsx 4.23.15, esbuild 0.28.2,
get-tsconfig 4.14.3 and picomatch deduplication, but leaves esbuild 0.18.20.

This change leaves Drizzle Kit at 0.31.10 and does not incorporate those unrelated updates.
Both PRs touch package.json and pnpm-lock.yaml. A read-only `git apply --check` of PR #135's patch
against this change failed on pnpm-lock.yaml; the existing patch cannot be applied unchanged.
This is a concrete lockfile overlap, not evidence that the intended updates are incompatible.
Whichever change lands second must regenerate/reconcile the lockfile, preserve the scoped
override until the legacy chain is removed, and repeat relevant verification. Do not accept a
whole-file lockfile replacement that restores vulnerable versions. PR #135 remains untouched.

## Verification results

Host: Node.js 24.11.0 and Corepack-selected pnpm 11.20.0. Docker runtime: Node.js 24.21.0.
Integration: a newly created PostgreSQL 18 container, loopback-only ephemeral port and tmpfs data,
using public CI-only test credentials. The test container was removed after verification.
No production service, real Discord token, secret configuration, or `.env` file was accessed.

| Check                                                                                                        | Result                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `corepack pnpm install --frozen-lockfile` in a separate clean checkout copy, empty store and no node_modules | PASS                                                               |
| Fresh frozen installation in the task worktree                                                               | PASS                                                               |
| Dependency paths, duplicate versions, old-version absence, manifest/lockfile consistency                     | PASS                                                               |
| Official advisory affected-range comparison for all 14 findings                                              | PASS                                                               |
| `corepack pnpm format:check`                                                                                 | PASS                                                               |
| `corepack pnpm lint`                                                                                         | PASS                                                               |
| `corepack pnpm typecheck`                                                                                    | PASS                                                               |
| `corepack pnpm test`                                                                                         | PASS: 76 files, 2768 tests                                         |
| `corepack pnpm build`                                                                                        | PASS                                                               |
| `corepack pnpm db:check`                                                                                     | PASS                                                               |
| Disposable `corepack pnpm db:generate` and copied-history rejection                                          | PASS                                                               |
| Legacy loader and core-utils compatibility probes                                                            | PASS                                                               |
| `corepack pnpm test:integration`                                                                             | PASS: 39 files, 689 tests; no skips                                |
| `git diff --check`                                                                                           | PASS                                                               |
| `corepack pnpm audit --json`                                                                                 | PASS: zero vulnerabilities, including development dependencies     |
| `corepack pnpm audit --prod --json`                                                                          | PASS: zero vulnerabilities                                         |
| Production graph comparison with main                                                                        | PASS: identical full production graph                              |
| Production Docker build                                                                                      | PASS                                                               |
| Runtime image dependency inspection                                                                          | PASS: same 63 unique production name/version pairs as source graph |
| Runtime user, command, tool exclusion and compiled migration module resolution                               | PASS: `node`, `node dist/index.js`; development tools absent       |

The Docker build context contained only the explicitly required non-secret build inputs.
The runtime inspection resolved migration dependencies without invoking migrations or starting
Discord. Dockerfile, dependency classification, and production behavior remain unchanged.

Initial failed attempts were investigated and rerun successfully: sandbox DNS/Docker access
restrictions; a globally installed pnpm 11.27.1 selected by a nested process (fixed using a
temporary Corepack shim, without changing project configuration); an inconsistent fdir snapshot
reference introduced while reverting unrelated deduplication (corrected before final frozen
installs and Docker build); and seven unit tests blocked by sandbox HTTP/spawn permissions
(all 2768 passed with normal execution permissions, without changing tests). Temporary smoke
fixtures also needed realpath-based dependency resolution, ESM package metadata and a relative
Drizzle output path; their final runs exercised the intended transforms and history collision.
The final loader probe also explicitly checks for spawn errors and its completion marker after
the sandbox returned an EPERM spawn error with a misleading zero status.
These initial failures are not counted as successful checks.

## Acceptance and remaining work

All locally verifiable Issue #138 criteria pass: affected paths and constraints are identified,
the 11 original findings and three additional findings are remediated, manifest/configuration
changes are limited, production dependencies are unchanged, frozen installation and all requested
checks pass, migration tools work, and Docker dependency isolation is verified. No known
unresolved GHSA remains in either final audit.

The criterion requiring corresponding GitHub Dependabot alerts to be verified **after merging**
is pending. No remote alert Closed state is claimed. The maintainer must verify it after merge.
An independent final review before committing remains necessary, particularly for the
out-of-range esbuild override and PR #135 lockfile coordination. No commit, push, PR creation,
merge, remote Issue/PR operation, or security-alert dismissal was performed.

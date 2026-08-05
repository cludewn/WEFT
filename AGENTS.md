# Repository Instructions

## Project

WEFT is a self-hosted Discord bot focused on Discord thread management and persistent scheduled actions.

Before planning or changing code, read:

- `docs/specification.md`
- `docs/development.md`
- the relevant GitHub Issue, when one exists

The specification documents are authoritative. Do not silently change product behavior to match an implementation.

## Hard prohibitions

Do not:

- read, inspect, print, copy, modify, summarize, or expose `.env` files,
- expose, log, or commit secrets,
- run broad environment-dump commands such as `env` or `printenv`,
- access production services or credentials without explicit authorization,
- use destructive Git commands without explicit approval,
- discard or overwrite existing user changes,
- commit, push, create or merge Pull Requests, or rewrite Git history without explicit instruction,
- introduce Redis, microservices, a web interface, or additional runtime services without explicit approval,
- request the Discord `Administrator` permission,
- convert Discord snowflake IDs to JavaScript numbers,
- perform unrelated refactoring,
- modify files outside the approved task scope without first reporting why,
- invent behavior for unresolved product decisions,
- implement deferred features or create placeholders for them,
- create abstractions, interfaces, repositories, adapters, modules, or directories without a concrete current need,
- add unrelated dependencies or update unrelated dependency versions,
- copy or substantially adapt third-party source code without explicit authorization and license review,
- weaken, delete, skip, or bypass tests, validation, or authorization merely to make checks pass,
- claim that a verification command passed unless it was actually executed successfully.

## Required stack

Use the following technologies unless an explicitly approved task changes them:

- Node.js 24 LTS
- TypeScript
- ECMAScript modules
- TypeScript strict mode
- pnpm
- discord.js
- PostgreSQL 18
- Drizzle ORM
- pg-boss
- Zod
- Vitest
- Pino
- Docker
- Docker Compose

Do not replace these technologies without an approved specification or task change.

## Architecture

- Keep the application as a modular monolith.
- Keep command and event handlers thin.
- Put use-case orchestration in application-level code.
- Keep rules that do not require external systems independent of Discord and database details.
- Keep Discord API access near a clear Discord integration boundary.
- Keep database queries out of Discord handlers and independent product rules.
- Do not expose discord.js objects throughout the application unnecessarily.
- Prefer the smallest structure that clearly separates current responsibilities.
- Organize closely related feature code together where practical.
- Do not create speculative abstractions or generic frameworks for future features.
- Do not create unused directories, empty modules, or placeholder implementations.
- Do not create a separate layer merely to match an architectural pattern.
- Introduce an interface only when it provides a meaningful architectural or testing boundary.
- Avoid generic `utils`, `common`, or `shared` modules unless multiple concrete callers justify them.
- Evolve the physical directory structure from implemented use cases rather than anticipated future features.
- Explain significant structural changes before implementing them.
- Do not implement deferred features unless explicitly requested.

## Discord rules

- Represent Discord snowflake IDs as strings.
- Never convert a Discord snowflake ID to a JavaScript `number`.
- Treat current Discord resource state as an external fact that may differ from stored state.
- Treat PostgreSQL as authoritative for WEFT configuration, scheduling data, managed-resource metadata, and audit history.
- Inspect current Discord state before performing administrative changes.
- Revalidate relevant Discord state and permissions immediately before delayed actions execute.
- Make operations idempotent where practical.
- Use ephemeral responses for validation and authorization failures.
- Do not request the Discord `Administrator` permission.
- Request only the permissions required by implemented features.
- Suppress mentions by default in messages containing user-provided content.
- Do not expose inaccessible channel names or message content in user-facing errors.
- Do not overwrite legitimate manual Discord changes from stale stored state unless an approved active policy explicitly requires enforcement.

## Security

- Never read, inspect, print, copy, modify, summarize, or expose `.env` files.
- Use `.env.example` only to identify required environment variable names.
- Never place real secrets in source code, tests, fixtures, logs, documentation, commits, Issues, or Pull Requests.
- Never log Discord tokens, database passwords, webhook URLs, or credential-bearing connection strings.
- Do not run `env`, `printenv`, or equivalent broad environment-dump commands.
- Do not weaken authorization or validation for development convenience.
- Do not access production services or credentials unless an explicit task authorizes it.
- Do not send user-controlled mentions unless an approved feature explicitly permits them.
- Do not expose secrets, stack traces, database details, inaccessible channel names, or inaccessible message content in user-facing errors.
- Do not print configuration objects when they may contain credentials.
- Use non-sensitive placeholder values in examples, tests, and documentation.

## Third-party code

- Do not copy or substantially adapt third-party source code unless the task explicitly authorizes it.
- Reading a third-party project for research does not authorize copying its implementation.
- Do not unnecessarily reproduce another project's code structure or expressions when independently implementing similar behavior.
- If source code would be copied or substantially adapted, stop and report:
  - the source project,
  - the applicable license,
  - the files that would contain adapted code,
  - the required attribution or notice.
- Do not add a third-party bot application as a runtime dependency without explicit approval.
- Do not assume that a permissive license guarantees correctness, security, maintenance quality, or compatibility.

## Scope control

- Inspect the relevant existing files before making changes.
- Treat the current task or Issue as the scope contract.
- Do not modify unrelated files.
- Do not perform unrelated refactoring.
- Do not rename established concepts without approval.
- Do not add a runtime dependency without explaining why it is necessary.
- Do not update unrelated dependencies.
- Do not create placeholders for deferred features.
- When a requirement is unclear, report the ambiguity instead of inventing product behavior.
- When implementation conflicts with the specification, report the conflict instead of silently changing either side.
- Preserve existing user changes that are unrelated to the current task.
- Do not expand the task merely because adjacent improvements appear convenient.
- Report why an out-of-scope file must change before modifying it.
- Prefer a focused change that can be reviewed and reverted independently.

## Specification changes

- Do not change approved product behavior merely to simplify implementation.
- When implementation reveals a missing, contradictory, ambiguous, or impractical requirement, stop and report it before continuing.
- Explain:
  - the current approved specification,
  - the implementation constraint or newly discovered fact,
  - the available options,
  - the recommended option and its tradeoffs,
  - the affected behavior and files.
- Do not make a product decision on behalf of the maintainer.
- Do not update specification files unless explicitly instructed.
- Do not treat an implementation limitation as an approved product requirement.
- After a specification change is approved, update the relevant documentation before or together with the implementation.
- Update tests and acceptance criteria when an approved behavior changes.
- Do not leave the implementation, tests, and approved specification knowingly inconsistent.
- If the current task cannot proceed without a specification decision, complete all unaffected work that remains valid, then report the blocking decision clearly.

## Language

Use English for:

- source code,
- identifiers,
- comments,
- repository documentation,
- branch names,
- commit messages,
- Issues,
- Pull Requests.

Use clear and direct technical English.

Do not use unnecessarily complex wording when a simpler technical statement is equally precise.

## Commit messages

Use Conventional Commits.

Allowed types:

- `feat`: a new user-visible feature or capability
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting-only changes that do not affect behavior
- `test`: test-only changes
- `refactor`: internal restructuring without a behavior change
- `perf`: a performance improvement
- `build`: build-system or dependency-management changes
- `ci`: continuous-integration changes
- `chore`: repository maintenance not covered by another type
- `revert`: a revert of an earlier commit

Use the following format:

`<type>(optional-scope): <imperative summary>`

Examples:

`docs: define the initial WEFT specification`

`chore: initialize the TypeScript project`

`build: add the PostgreSQL development service`

`feat(thread): implement the close subcommand`

`fix(thread): prevent duplicate closed prefixes`

`style: format the TypeScript sources`

`test(thread): cover close authorization`

`refactor(discord): isolate thread API operations`

Rules:

- Select the type according to the primary purpose of the change.
- Use an imperative, lowercase summary.
- Do not end the summary with a period.
- Do not use vague summaries such as `update files`, `misc changes`, or `fix stuff`.
- Use `style` only when runtime behavior does not change.
- Use `build` for dependency, package-manager, compiler, or build-configuration changes.
- Use `chore` only when no more specific type applies.
- Keep one logical change per commit.
- Separate formatting-only changes from behavioral changes when combining them would obscure the functional diff.
- Do not split one logical change into many trivial commits.
- Use `!` and a `BREAKING CHANGE:` footer only for an actual breaking change.
- Do not commit unless explicitly requested.

## Testing

- Add or update tests for changed behavior.
- Prefer testing application behavior without a live Discord connection.
- Replace infrastructure boundaries with fakes or mocks where appropriate.
- Use a real PostgreSQL instance for tests whose correctness depends on PostgreSQL behavior.
- Test validation and authorization failures.
- Test repeated execution and idempotency.
- Test concurrent or conflicting changes where relevant.
- Test partial external failures where relevant.
- Test scheduled-action cancellation races where relevant.
- Test restart and overdue-job behavior for scheduling features.
- Do not delete or weaken tests merely to obtain a passing result.
- Do not bypass failing tests by excluding the affected files or cases without approval.
- Do not claim that behavior is tested when the relevant test was not executed.
- Do not require a live Discord bot, a production guild, production credentials, or the real `.env` file for ordinary automated tests.

## Verification

Run the relevant available checks after changes.

The expected standard commands, once configured, are:

    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm build

Validate Docker Compose after infrastructure changes.

Never claim that a check passed unless it was actually run successfully.

If a command cannot be run, report:

- which command was skipped,
- why it was skipped,
- what remains unverified.

At the end of a task, report:

- changed files,
- added or removed dependencies,
- commands executed,
- successful checks,
- failed checks,
- skipped checks,
- unresolved problems.

## Git operations

- Do not commit unless explicitly requested.
- Do not push.
- Do not create or merge a Pull Request unless explicitly requested.
- Do not rewrite Git history.
- Do not discard user changes.
- Do not use destructive Git commands without explicit approval.
- Do not use force-push operations.
- Do not amend an existing commit without explicit instruction.
- Do not change branches unexpectedly.
- Keep the resulting changes suitable for one logical commit whenever practical.

## Agent workflow

For a non-trivial task:

1. Read the relevant specification and Issue.
2. Inspect the related code and repository state.
3. Identify ambiguities, specification conflicts, security concerns, and licensing concerns.
4. Present an implementation plan before editing when requested.
5. State which files or areas are expected to change.
6. Change only the approved scope.
7. Run the relevant verification.
8. Review the resulting diff.
9. Report the results accurately.

Do not proceed with an unresolved product decision by inventing a default.

Do not treat generated code as correct merely because it compiles.

Do not conceal failed commands, incomplete behavior, assumptions, or unresolved risks.

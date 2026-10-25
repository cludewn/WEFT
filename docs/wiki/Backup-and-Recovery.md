# Backup and recovery

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Backup-and-Recovery-ja)

Use this page to create a private database backup or restore a trusted archive. These are host operations, not Discord commands.

<a id="choose-a-procedure"></a>

## Choose the procedure

| Need                               | Follow this route                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Take a backup without upgrading    | Verify the app stop → [create and inspect](#create-and-inspect-a-backup) → [restart the same release](#continue-after-backup).                                                            |
| Take a backup during an upgrade    | Follow [the upgrade sequence](Operations#upgrade-in-order): prepare the new image → verify the old app stop → create and inspect → keep the app stopped and return to migration.          |
| Restore a backup                   | Assess Discord effects → verify stop and target → [delete, recreate and restore the DB](#restore-into-a-clean-target-database) → [verify, migrate and start](#verify-migrate-then-start). |
| Check that backups can be restored | Use the [isolated restore drill](#private-storage-and-restore-drills); do not start Discord.                                                                                              |

A database restore does not undo Discord sends, edits, names, archive state, deletions or permissions.
**Restoring old scheduling state can make a post already sent after the backup eligible again.**
Review those external effects before deciding to restore. Fresh checks, stored IDs and duplicate
reduction help, but do not guarantee exactly-once recovery. Keep the app stopped until you have assessed that risk
and confirmed the target database.

<a id="prepare-a-stopped-known-deployment"></a>

## Prepare access and verify the stopped deployment

The supported format is a complete single-database PostgreSQL 18 custom archive, made with pg_dump
--format=custom. This procedure does not support copying a live volume, merging plain SQL, changing the database
major version or downgrading the application. Use a trusted archive: restore can execute SQL.

Work from the intended Compose checkout. Follow [Stop and verify](Operations#stop-and-verify):
stop app with `docker compose stop -t 45 app`, require exit 0 and a matching shutdown_completed,
and keep PostgreSQL running. An already-stopped deployment needs evidence for its last relevant
stop. A target where WEFT has never started instead needs confirmation that no app/process connects
to that DB; do not start Discord merely to obtain a shutdown log. Unknown/crashed shutdown is not
the never-started case. Investigate before continuing.

Before continuing, confirm:

- Supported PostgreSQL 18 custom format and the database access needed for the chosen procedure. For restore, also confirm archive trust and database creation permissions.
- Correct Compose project, source/target application version, target database and role.
- PostgreSQL is running while the app is stopped.
- Either the last relevant app stop is verified, or this target has never run WEFT and no process connects to it. A crash/unknown stop is not the never-started case.

<a id="create-and-inspect-a-backup"></a>

## Create, inspect and record a backup

With the app stopped, choose a private directory outside the repository:

```sh
(
  set -e
  umask 077
  backup_dir="$HOME/weft-backups"
  mkdir -p -- "$backup_dir"
  chmod 700 -- "$backup_dir"
  partial_file=$(mktemp "$backup_dir/weft-pg18.XXXXXX.partial")
  archive_file="${partial_file%.partial}.dump"
  docker compose exec -T postgres sh -c 'exec pg_dump --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$partial_file"
  docker compose exec -T postgres pg_restore --list < "$partial_file" > /dev/null
  mv -- "$partial_file" "$archive_file"
  printf '%s\n' "$archive_file"
)
```

-T preserves binary output; dump stdout goes only to the private file. Promote the partial file only
after both commands succeed. A failed backup changes no DB data; a leftover partial is not a valid
backup. Listing checks the table of contents, not complete restoreability or archive safety.
Inspect the saved archive’s table of contents before treating it as the completed backup:

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
```

Replace the path with the archive just printed and check each command. Record UTC backup time, database name, PostgreSQL major version, source WEFT/image revision and
intended target release with the archive. A schema groups tables and other objects within one database. Check these schema entries in the table of contents:

| Schema    | Why it matters for recovery                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `public`  | WEFT's configuration, managed-resource records, schedules and audit data            |
| `drizzle` | The history of WEFT database migrations                                             |
| `pgboss`  | The scheduler's internal queues and job state, if the schema existed at backup time |

These schemas are parts of the same database, not separate backup targets. Keep the complete archive; do not extract only the WEFT tables or discard scheduler state.

<a id="continue-after-backup"></a>

### Choose what to do after the backup

Continue only after archive creation, inspection and recording succeed. The next action depends on why you took the backup:

- **Backup without an upgrade:** restart the same source release and [verify readiness](Installation-and-Setup#verify-the-first-run). Backup alone requires no migration. Confirm that the selected image is still that source release before starting it.
- **Backup during an upgrade:** keep the app stopped and PostgreSQL running. Return to [the upgrade sequence](Operations#upgrade-in-order), step 5, to migrate with the prepared target image. Do not restart the old app between backup and migration.
- **Restore drill:** keep the Discord app stopped and continue [the isolated drill](#private-storage-and-restore-drills).

**End the backup procedure here.** The restore section below replaces a database and is only for a separately chosen recovery operation. Do not run it as part of taking a backup or performing an ordinary update.

<a id="restore-into-a-clean-target-database"></a>

## Verify the target, delete and recreate its database, then restore

Confirm the trusted nonempty archive, source/target release, correct Compose project, DB and role,
PostgreSQL availability and the applicable verified app-stop state. Never restore a newer backup
for an older app. Set an absolute private archive path and inspect it:

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
docker compose ps -a app
docker compose ps postgres
docker compose exec -T postgres sh -c 'printf "target database: %s; role: %s\n" "$POSTGRES_DB" "$POSTGRES_USER"'
```

Check every result. The next block **destroys the configured target database**; run only after all
preflight checks succeed. Its role needs ownership/drop, CREATE DATABASE and restored-object creation
capabilities. A single-database dump does not contain cluster-global role definitions. The provided
single-user Compose role owns restored objects because source owners/privileges are omitted.
An external DB needs equivalent preparation.

```sh
(
  set -e
  docker compose exec -T postgres sh -c 'exec dropdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec createdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres --template=template0 --owner="$POSTGRES_USER" "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec pg_restore --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' < "$backup_file"
)
```

Do not force-disconnect unexpected sessions; let drop fail and investigate. Do not merge into an
existing DB or use --clean --create (the archive would choose the DB name). Restore is one transaction
and fails on error in PostgreSQL 18, but that transaction cannot undo the preceding drop/create.
After any failure, keep the app stopped; never start it against a partial or unknown database.

<a id="verify-migrate-then-start"></a>

## Verify the restored database, migrate and start

First run the database checks. Do not run migrations or start the app until you have checked their results:

```sh
docker compose exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select current_database(), current_user;
select count(*) as guild_settings_rows from public.guild_settings;
select count(*) as drizzle_migration_rows from drizzle.__drizzle_migrations;
select to_regclass('pgboss.version') as pgboss_version_table;
SQL
```

Compare the database and role, representative counts and migration history without assuming a fixed count. The queries use `public` for WEFT data, `drizzle` for migration history and `pgboss.version` to check whether scheduler state is present. Preserve the complete scheduler schema/state.

After those checks succeed, run exactly one target-release migration process:

```sh
docker compose run --rm app node dist/migrate.js
```

Require successful completion. For the same version, expect a no-op; a newer target version may apply its committed migrations. Repeat the database checks afterward. Only then start the app, [check readiness](Installation-and-Setup#verify-the-first-run), and review
startup recovery and current Discord state. Readiness alone does not establish that restored reservations and records agree with the actual state in Discord.

<a id="private-storage-and-restore-drills"></a>

## Protect archives and test restoration

Archives may contain scheduled/managed payloads, IDs, audit history, configuration and scheduler state.
Restrict access like production data; never commit them or log their contents. Old backups can retain
audit content longer than runtime retention. Protect and manage them separately.

Periodically test an actual restore in a dedicated PostgreSQL 18 environment. **Keep the Discord application stopped throughout the drill.** Use only disposable test data. This is a preparation and verification checklist; the repository does not provide a complete drill runner, test-data loader or standalone pg-boss inspection command. Prepare those database-only tools before starting a drill that needs them.

### Prepare and identify the isolated target

Use the same `compose.yaml` and application revision as the data being tested. Create a private configuration file outside the repository containing drill-only database credentials; leave Discord credentials unset in both the file and the drill process environment. Do not copy production configuration into it. Separate these resources explicitly:

- **Compose project:** Choose a unique name, such as `weft-restore-drill-20261023`, and pass it with `--project-name` on **every** invocation. A different working directory alone is insufficient.

- **Configuration:** Pass the absolute drill-only file with `--env-file` and the intended `compose.yaml` with `-f`. Host-exported settings override the file; ensure they cannot substitute another database, role or port. Do not print resolved configuration or credentials.

- **Database and role:** Use distinct `DATABASE_NAME` and `DATABASE_USER`, for example `weft_restore_drill` and `weft_drill_owner`, with a new drill-only password. Confirm the actual database/role through the database checks below. Changing initialization settings does not rename a database or role inside an existing volume.

- **Port:** Set an unused host `DATABASE_PORT`, for example `55432` if available. The PostgreSQL container still listens on 5432; the app's migration container uses `postgres:5432` on this project's network.

- **Volume:** The supplied Compose file creates a project-scoped `postgres-data` volume mounted at `/var/lib/postgresql/`. Verify the actual PostgreSQL container's project label, volume name and mount in Docker's container/volume details. Do not reuse a development or production volume or add an external-volume override.

- **Archive:** Choose a private drill directory and a new archive path. Record its source database, revision and expected data; do not confuse it with the deployment's backup directory.

For example, this **read-only** invocation selects the intended project, file and Compose definition. Replace the paths and project name with your drill's actual values:

```sh
docker compose --project-name weft-restore-drill-20261023 --env-file /absolute/private/path/drill.conf -f /absolute/path/to/WEFT/compose.yaml ps -a
```

Use that entire Compose prefix in place of **every** `docker compose` in the drill and linked procedures, including the examples earlier on this page for migration, backup and restore, and later cleanup. Do not fall back to an unqualified command from your normal checkout. See Docker's [project-name selection](https://docs.docker.com/compose/how-tos/project-name/) and [variable precedence](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

### Run the drill and compare evidence

1. Start **only** the drill's PostgreSQL service. Check the project, container, host port and mounted volume against your recorded drill identities. Verify that no Discord app is running against this DB. Apply WEFT migrations using the one-shot `node dist/migrate.js` command, which does not connect to Discord or initialize pg-boss.
2. Prepare recognizable, schema-valid disposable rows using a reviewed test-data loader. Record representative values and counts for configuration, schedules and audit data, Drizzle history, and object ownership/usability by the configured role. Do not invent rows that bypass the current constraints.
3. If testing scheduler recovery, first prepare a database-only harness using the installed pg-boss version. It must connect only to this drill DB, start and stop pg-boss without importing WEFT's app entrypoint, connecting to Discord or registering send/close workers, and close its pool. Record whether `pgboss.version`, expected queues and representative job state exist. WEFT migrations do not create this schema; pg-boss owns its initialization and internal migrations. If the harness is not ready, defer this part and record scheduler usability as unverified.
4. Follow [backup creation and inspection](#create-and-inspect-a-backup) with the drill prefix and private path. Compare the archive table of contents with the schemas actually present: `public`, `drizzle`, and `pgboss` when initialized. Do not restart the Discord app after the drill backup.
5. **Immediately before the database drop**, repeat the drill-prefix `ps` checks and the target DB/role check from [restore preflight](#restore-into-a-clean-target-database). Also run the read-only `current_database()` / `current_user()` [database check](#verify-migrate-then-start) and reconfirm the container's project label, host port and volume. If any identity differs or is unknown, stop.

   The drill DB still contains the test data inserted in step 2. Only after confirming the target, run the existing restore block against the **drill DB**: it **deletes that database and its test data**, recreates the database, then restores the archive saved in step 4. This is database replacement, not an import into the existing database. Do not add force-disconnection or schema-reset commands.

6. Compare the restored rows, counts, Drizzle history and ownership with the observations recorded before backup, using the reviewed queries prepared with your test-data loader.

   The SQL supplied above checks the connected DB/role, configuration and migration row counts, and whether `pgboss.version` exists; it does not compare all test data or inspect scheduler queues/jobs. A successful archive listing alone is insufficient.

   If the archive included `pgboss`, check its restored version table and, with your prepared inspection queries, the scheduler state recorded in step 3. Do not accept a newly created empty schema as recovery.

   Run same-release WEFT migration and require success without new migrations. **Only if the database-only pg-boss harness was prepared in step 3**, use it to check start/stop compatibility and expected queue/state access. Otherwise, record pg-boss startup and queue/job usability as unverified. Do not clear scheduler state or start workers. Keep the Discord app stopped.

7. Test an invalid archive only against the same disposable target. Require a nonzero result and no app startup. The restore transaction cannot undo the preceding drop/create; a failed restore leaves the target unusable until a later verified restore. Preserve the known-good drill archive until the investigation is complete.

### Finish the drill

Record the target identities, application/PostgreSQL versions, archive source, before/after comparisons, command outcomes and anything not tested.

Report data restoration and pg-boss operation separately. Successful row/history checks establish only the data restoration you actually checked; without the pg-boss harness, scheduler operation remains unverified and the full scheduler recovery drill is incomplete. An archive without initialized pg-boss state cannot demonstrate recovery of that state.

Keep this non-sensitive drill report; do not attach payloads, credentials or the archive. After recording and resolving failures, remove only the drill project's containers/network, its verified dedicated volume, drill archives/test data, and temporary configuration/credentials or harness artifacts. Recheck each resource's project/identity before deletion. Keep production/development resources, source files and their backups. No generic volume-deletion command is supplied here because selecting the wrong project would destroy unrelated data.

A table-of-contents listing is not a substitute for this drill. The repository's
[operator procedure](https://github.com/cludewn/WEFT/blob/main/docs/development.md#production-backup-and-restore-operations)
provides further detail.

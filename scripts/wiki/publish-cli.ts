import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { publishWiki, runGit, WikiPublicationError } from "./publish.js";

let sourceSha = "unresolved";
try {
  const repository = process.env.GITHUB_REPOSITORY;
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "") ||
    repository === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !process.env.WIKI_TOKEN
  )
    throw new WikiPublicationError("UNAPPROVED_PUBLICATION_CONTEXT");
  sourceSha = runGit(resolve("."), ["rev-parse", "HEAD"]).trim();
  const result = publishWiki({
    sourceDirectory: resolve("."),
    sourceSha,
    repository,
    sourceRemote: `https://github.com/${repository}.git`,
    wikiRemote: `https://github.com/${repository}.wiki.git`,
  });
  const summary = `Wiki publication: **${result.result}**\n\nRequested latest main: \`${result.sourceSha}\`\n\nRecorded content source: \`${result.recordedSourceSha}\`\n\nConfirmed Wiki revision: \`${result.wikiSha}\`\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
} catch (error) {
  const code =
    error instanceof WikiPublicationError ? error.code : "WIKI_VALIDATION_OR_PUBLICATION_FAILED";
  const summary = `Wiki publication: **failed** (${code})\n\nSource revision: \`${/^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : "unresolved"}\`\n\nNo publication success is claimed. Follow docs/wiki-publishing.md before retrying latest main.\n`;
  console.error(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = 1;
}

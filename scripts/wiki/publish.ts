import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { digest, readWikiSources, safePageName, validateGuide } from "./content.js";

export const MANIFEST = ".weft-wiki-manifest.json";
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const manifestSchema = z.strictObject({
  version: z.literal(1),
  repository: z.string().regex(repositoryPattern),
  sourceSha: z.string().regex(shaPattern),
  pages: z
    .array(
      z.strictObject({
        path: z.string().refine(safePageName),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(200),
});
type Manifest = z.infer<typeof manifestSchema>;

export class WikiPublicationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WikiPublicationError";
  }
}

/** Only this boundary sees Git output. Failures never expose stderr, URLs or credentials. */
export type Git = (cwd: string, args: readonly string[]) => string;
export const runGit: Git = (cwd, args) => {
  try {
    return execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 20_000_000,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TRACE: "0",
          GIT_TRACE_PACKET: "0",
          GIT_TRACE_CURL: "0",
          GIT_CURL_VERBOSE: "0",
        },
      },
    );
  } catch {
    throw new WikiPublicationError("GIT_OPERATION_FAILED");
  }
};

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WikiPublicationError(code);
}

function remoteMain(git: Git, cwd: string, remote: string): string {
  const output = git(cwd, ["ls-remote", "--exit-code", "--", remote, "refs/heads/main"]).trim();
  const match = /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(output);
  ensure(match !== null, "MAIN_REVISION_UNCONFIRMED");
  return match[1]!;
}

function remoteWiki(git: Git, cwd: string, remote: string): { branch: string; sha: string } {
  const output = git(cwd, ["ls-remote", "--symref", "--", remote, "HEAD"]);
  const branch = /^ref: (refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*)\tHEAD$/m.exec(output)?.[1];
  const sha = /^([0-9a-f]{40})\tHEAD$/m.exec(output)?.[1];
  ensure(branch !== undefined && sha !== undefined, "WIKI_DEFAULT_BRANCH_UNCONFIRMED");
  git(cwd, ["check-ref-format", branch]);
  return { branch, sha };
}

function tree(git: Git, cwd: string, revision: string, prefix?: string): string[] {
  const entries = git(cwd, [
    "ls-tree",
    "-rz",
    "--full-tree",
    revision,
    ...(prefix ? ["--", prefix] : []),
  ]);
  return entries
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^100644 blob [0-9a-f]{40}\t(.+)$/.exec(entry);
      ensure(match !== null, "UNSAFE_GIT_TREE");
      return match[1]!;
    })
    .sort();
}

export type PublicationResult = {
  result: "published" | "noop";
  sourceSha: string;
  recordedSourceSha: string;
  wikiSha: string;
};

export type PublicationOptions = {
  sourceDirectory: string;
  sourceRemote: string;
  wikiRemote: string;
  sourceSha: string;
  repository: string;
  git?: Git;
};

/** Synchronizes a freshly cloned Wiki. The caller must serialize publications. */
export function publishWiki({
  sourceDirectory,
  sourceRemote,
  wikiRemote,
  sourceSha,
  repository,
  git = runGit,
}: PublicationOptions): PublicationResult {
  ensure(
    shaPattern.test(sourceSha) && repositoryPattern.test(repository),
    "INVALID_PUBLICATION_IDENTITY",
  );
  const sources = readWikiSources(join(sourceDirectory, "docs/wiki"));
  validateGuide(sources);
  ensure(
    git(sourceDirectory, ["rev-parse", "HEAD"]).trim() === sourceSha,
    "SOURCE_CHECKOUT_MISMATCH",
  );
  const expectedPaths = [...sources.keys()].map((path) => `docs/wiki/${path}`).sort();
  ensure(
    JSON.stringify(tree(git, sourceDirectory, sourceSha, "docs/wiki")) ===
      JSON.stringify(expectedPaths),
    "SOURCE_TREE_MISMATCH",
  );
  for (const [path, content] of sources) {
    ensure(
      git(sourceDirectory, ["show", `${sourceSha}:docs/wiki/${path}`]) === content,
      "SOURCE_CONTENT_MISMATCH",
    );
  }
  ensure(remoteMain(git, sourceDirectory, sourceRemote) === sourceSha, "STALE_SOURCE");
  const initial = remoteWiki(git, sourceDirectory, wikiRemote);
  const temporary = mkdtempSync(join(tmpdir(), "weft-wiki-"));
  const wiki = join(temporary, "wiki");
  try {
    git(temporary, ["clone", "--no-checkout", "--origin", "wiki", "--", wikiRemote, wiki]);
    const paths = tree(git, wiki, initial.sha);
    let previous: Manifest | undefined;
    if (paths.includes(MANIFEST)) {
      const text = git(wiki, ["show", `${initial.sha}:${MANIFEST}`]);
      ensure(text.length < 100_000, "INVALID_MANIFEST");
      try {
        previous = manifestSchema.parse(JSON.parse(text) as unknown);
      } catch {
        throw new WikiPublicationError("INVALID_MANIFEST");
      }
      ensure(previous.repository === repository, "MANIFEST_REPOSITORY_MISMATCH");
      const managed = previous.pages.map((page) => page.path).sort();
      ensure(
        new Set(managed.map((path) => path.toLowerCase())).size === managed.length,
        "INVALID_MANIFEST",
      );
      ensure(
        JSON.stringify(paths) === JSON.stringify([...managed, MANIFEST].sort()),
        "UNMANAGED_WIKI_CONTENT",
      );
      for (const page of previous.pages) {
        ensure(
          digest(git(wiki, ["show", `${initial.sha}:${page.path}`])) === page.sha256,
          "WIKI_CONTENT_CHANGED_OUTSIDE_SOURCE",
        );
      }
      try {
        git(sourceDirectory, ["merge-base", "--is-ancestor", previous.sourceSha, sourceSha]);
      } catch {
        throw new WikiPublicationError("PUBLISHED_SOURCE_NOT_ANCESTOR");
      }
    } else {
      // Only the explicitly documented seed Home is adopted; its Git history is retained.
      ensure(paths.length === 1 && paths[0] === "Home.md", "UNMANAGED_BOOTSTRAP_CONTENT");
      ensure(
        git(wiki, ["show", `${initial.sha}:Home.md`]).trim().length > 0,
        "EMPTY_BOOTSTRAP_HOME",
      );
    }
    const next: Manifest = {
      version: 1,
      repository,
      sourceSha,
      pages: [...sources]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, content]) => ({ path, sha256: digest(content) })),
    };
    const unchanged =
      previous !== undefined && JSON.stringify(previous.pages) === JSON.stringify(next.pages);
    if (!unchanged) {
      ensure(previous?.sourceSha !== sourceSha, "SAME_REVISION_DIFFERENT_CONTENT");
      git(wiki, ["checkout", "--detach", initial.sha]);
      for (const page of previous?.pages ?? [])
        if (!sources.has(page.path)) unlinkSync(join(wiki, page.path));
      for (const [path, content] of sources) writeFileSync(join(wiki, path), content, "utf8");
      writeFileSync(join(wiki, MANIFEST), `${JSON.stringify(next, null, 2)}\n`, "utf8");
      const managedPaths = [
        ...new Set([
          MANIFEST,
          ...sources.keys(),
          ...(previous?.pages.map((page) => page.path) ?? []),
        ]),
      ];
      git(wiki, ["add", "--all", "--", ...managedPaths]);
      git(wiki, [
        "-c",
        "user.name=WEFT Wiki publisher",
        "-c",
        "user.email=wiki-publisher@users.noreply.github.com",
        "commit",
        "--no-gpg-sign",
        "-m",
        `docs: publish Wiki from ${sourceSha}`,
      ]);
    }
    // Last network observations before push (also required for a confirmed no-op).
    ensure(
      remoteMain(git, sourceDirectory, sourceRemote) === sourceSha,
      "SOURCE_ADVANCED_BEFORE_PUSH",
    );
    const latest = remoteWiki(git, wiki, wikiRemote);
    ensure(
      latest.branch === initial.branch && latest.sha === initial.sha,
      "WIKI_ADVANCED_BEFORE_PUSH",
    );
    if (unchanged)
      return {
        result: "noop",
        sourceSha,
        recordedSourceSha: previous!.sourceSha,
        wikiSha: latest.sha,
      };
    const proposed = git(wiki, ["rev-parse", "HEAD"]).trim();
    let pushFailed = false;
    try {
      git(wiki, ["push", "wiki", `HEAD:${initial.branch}`]);
    } catch {
      pushFailed = true;
    }
    let confirmed: { branch: string; sha: string };
    try {
      confirmed = remoteWiki(git, wiki, wikiRemote);
    } catch {
      throw new WikiPublicationError("PUSH_RESULT_UNCONFIRMED");
    }
    ensure(
      confirmed.branch === initial.branch && confirmed.sha === proposed,
      pushFailed && confirmed.sha === initial.sha ? "PUSH_FAILED" : "PUSH_RESULT_UNCONFIRMED",
    );
    return { result: "published", sourceSha, recordedSourceSha: sourceSha, wikiSha: confirmed.sha };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

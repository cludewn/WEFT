import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST,
  publishWiki,
  runGit,
  WikiPublicationError,
  type Git,
} from "../../scripts/wiki/publish.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function commit(directory: string, message = "fixture revision"): string {
  runGit(directory, ["add", "--all", "--", "."]);
  runGit(directory, [
    "-c",
    "user.name=Wiki fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ]);
  return runGit(directory, ["rev-parse", "HEAD"]).trim();
}

function fixture(branch = "wiki-default") {
  const root = mkdtempSync(join(tmpdir(), "weft-wiki-fixture-"));
  temporary.push(root);
  const source = join(root, "source");
  const remote = join(root, "source.git");
  const seed = join(root, "seed");
  const wiki = join(root, "wiki.git");
  for (const directory of [source, remote, seed, wiki]) mkdirSync(directory);
  runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  runGit(source, ["init", "--initial-branch=main"]);
  mkdirSync(join(source, "docs"));
  cpSync(resolve(import.meta.dirname, "../../docs/wiki"), join(source, "docs/wiki"), {
    recursive: true,
  });
  let sha = commit(source);
  runGit(source, ["remote", "add", "source", remote]);
  runGit(source, ["push", "source", "main"]);
  runGit(root, ["init", "--bare", `--initial-branch=${branch}`, wiki]);
  runGit(seed, ["init", `--initial-branch=${branch}`]);
  writeFileSync(
    join(seed, "Home.md"),
    "# Initial Home\n\nCanonical sources will replace this seed.\n",
  );
  const initialWiki = commit(seed);
  runGit(seed, ["remote", "add", "wiki", wiki]);
  runGit(seed, ["push", "wiki", branch]);
  return {
    source,
    remote,
    seed,
    wiki,
    initialWiki,
    get sha() {
      return sha;
    },
    publish(git?: Git) {
      return publishWiki({
        sourceDirectory: source,
        sourceRemote: remote,
        wikiRemote: wiki,
        sourceSha: sha,
        repository: "fixture/WEFT",
        ...(git ? { git } : {}),
      });
    },
    advance() {
      sha = commit(source);
      runGit(source, ["push", "source", "main"]);
      return sha;
    },
    changeHome(label: string) {
      for (const page of ["Home.md", "Home-ja.md"]) {
        const path = join(source, "docs/wiki", page);
        writeFileSync(path, `${readFileSync(path, "utf8")}\nFixture revision ${label}.\n`);
      }
      return this.advance();
    },
    externalChange(path = "Home.md", content = "external change\n") {
      runGit(seed, ["fetch", "wiki", branch]);
      runGit(seed, ["checkout", "--detach", "FETCH_HEAD"]);
      writeFileSync(join(seed, path), content);
      const revision = commit(seed);
      runGit(seed, ["push", "wiki", `HEAD:refs/heads/${branch}`]);
      return revision;
    },
    head() {
      return runGit(root, ["--git-dir", wiki, "rev-parse", "HEAD"]).trim();
    },
    file(path: string) {
      return runGit(root, ["--git-dir", wiki, "show", `HEAD:${path}`]);
    },
  };
}

function extraPage(source: string, name = "Extra"): void {
  for (const suffix of ["", "-ja"]) {
    const other = suffix ? name : `${name}-ja`;
    writeFileSync(
      join(source, "docs/wiki", `${name}${suffix}.md`),
      `# Extra\n\n[Language](${other})\n\n## Note\nFixture content.\n`,
    );
  }
  const path = join(source, "docs/wiki/_Sidebar.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n[Extra](${name}) · [日本語](${name}-ja)\n`);
}

describe("local Git Wiki publication", () => {
  it.each(["master", "wiki-default"])(
    "adopts only seed Home, discovers %s and preserves history",
    (branch) => {
      const f = fixture(branch);
      const result = f.publish();
      expect(result).toMatchObject({
        result: "published",
        sourceSha: f.sha,
        recordedSourceSha: f.sha,
        wikiSha: f.head(),
      });
      expect(f.file("Home.md")).toBe(readFileSync(join(f.source, "docs/wiki/Home.md"), "utf8"));
      expect(f.file(MANIFEST)).toContain(f.sha);
      expect(
        runGit(f.source, [
          "--git-dir",
          f.wiki,
          "merge-base",
          "--is-ancestor",
          f.initialWiki,
          result.wikiSha,
        ]),
      ).toBe("");
      expect(runGit(f.source, ["--git-dir", f.wiki, "symbolic-ref", "HEAD"]).trim()).toBe(
        `refs/heads/${branch}`,
      );
    },
  );

  it("adds new page pairs and updates existing content", () => {
    const f = fixture();
    f.publish();
    extraPage(f.source);
    f.advance();
    f.publish();
    expect(f.file("Extra.md")).toContain("Fixture content");
    f.changeHome("B");
    f.publish();
    expect(f.file("Home.md")).toContain("revision B");
  });

  it("safely renames and deletes only previously managed page pairs", () => {
    const f = fixture();
    extraPage(f.source);
    f.advance();
    f.publish();
    for (const suffix of ["", "-ja"]) {
      const before = join(f.source, "docs/wiki", `Extra${suffix}.md`);
      const after = join(f.source, "docs/wiki", `Renamed${suffix}.md`);
      renameSync(before, after);
      writeFileSync(after, readFileSync(after, "utf8").replaceAll("Extra", "Renamed"));
    }
    const sidebar = join(f.source, "docs/wiki/_Sidebar.md");
    writeFileSync(sidebar, readFileSync(sidebar, "utf8").replaceAll("Extra", "Renamed"));
    f.advance();
    f.publish();
    expect(() => f.file("Extra.md")).toThrow();
    expect(f.file("Renamed.md")).toContain("Fixture content");
    rmSync(join(f.source, "docs/wiki/Renamed.md"));
    rmSync(join(f.source, "docs/wiki/Renamed-ja.md"));
    writeFileSync(
      sidebar,
      readFileSync(sidebar, "utf8")
        .split("\n")
        .filter((line) => !line.includes("Renamed"))
        .join("\n"),
    );
    f.advance();
    f.publish();
    expect(() => f.file("Renamed.md")).toThrow();
    expect(f.file(MANIFEST)).not.toContain("Renamed");
  });

  it("makes no commit/push for identical content, including a newer source-only revision", () => {
    const f = fixture();
    const first = f.publish();
    expect(f.publish()).toMatchObject({ result: "noop", wikiSha: first.wikiSha });
    writeFileSync(join(f.source, "note.txt"), "Non-Wiki source update.\n");
    f.advance();
    expect(f.publish()).toMatchObject({
      result: "noop",
      sourceSha: f.sha,
      recordedSourceSha: first.sourceSha,
      wikiSha: first.wikiSha,
    });
    expect(f.head()).toBe(first.wikiSha);
  });

  it.each([false, true])(
    "rejects unmanaged pages before/after initial publication (%s) without removing them",
    (published) => {
      const f = fixture();
      if (published) f.publish();
      f.externalChange("Notes.md", "# Human notes\n");
      const before = f.head();
      expect(() => f.publish()).toThrow(
        published ? "UNMANAGED_WIKI_CONTENT" : "UNMANAGED_BOOTSTRAP_CONTENT",
      );
      expect(f.head()).toBe(before);
      expect(f.file("Notes.md")).toContain("Human notes");
    },
  );

  it("rejects direct changes, corrupt manifests and unsafe destination Git modes", () => {
    const f = fixture();
    f.publish();
    f.externalChange();
    const before = f.head();
    expect(() => f.publish()).toThrow("WIKI_CONTENT_CHANGED_OUTSIDE_SOURCE");
    expect(f.head()).toBe(before);
    f.externalChange(MANIFEST, "{}\n");
    expect(() => f.publish()).toThrow("INVALID_MANIFEST");
    runGit(f.seed, ["fetch", "wiki", "wiki-default"]);
    runGit(f.seed, ["checkout", "--detach", "FETCH_HEAD"]);
    rmSync(join(f.seed, "Home.md"));
    symlinkSync("/tmp/not-read", join(f.seed, "Home.md"));
    commit(f.seed);
    runGit(f.seed, ["push", "wiki", "HEAD:refs/heads/wiki-default"]);
    expect(() => f.publish()).toThrow("UNSAFE_GIT_TREE");
  });

  it.each(["empty", "bad-path", "symlink", "uncommitted"])(
    "rejects %s source without changing remote",
    (kind) => {
      const f = fixture();
      const directory = join(f.source, "docs/wiki");
      if (kind === "empty") {
        rmSync(directory, { recursive: true });
        mkdirSync(directory);
      }
      if (kind === "bad-path") writeFileSync(join(directory, "Bad..md"), "unsafe\n");
      if (kind === "symlink") {
        rmSync(join(directory, "Home.md"));
        symlinkSync("Home-ja.md", join(directory, "Home.md"));
      }
      if (kind === "uncommitted")
        writeFileSync(
          join(directory, "Home.md"),
          `${readFileSync(join(directory, "Home.md"), "utf8")}\nUnsaved change.\n`,
        );
      expect(() => f.publish()).toThrow();
      expect(f.head()).toBe(f.initialWiki);
    },
  );

  it("rejects an old run after source main advanced, even before any new publication", () => {
    const f = fixture();
    const old = f.sha;
    f.changeHome("new");
    runGit(f.source, ["checkout", "--detach", old]);
    expect(() =>
      publishWiki({
        sourceDirectory: f.source,
        sourceRemote: f.remote,
        wikiRemote: f.wiki,
        sourceSha: old,
        repository: "fixture/WEFT",
      }),
    ).toThrow("STALE_SOURCE");
    expect(f.head()).toBe(f.initialWiki);
  });

  it("cannot overwrite a newer publication even if a stale remote-main observation reports old SHA", () => {
    const f = fixture();
    const old = f.sha;
    f.publish();
    f.changeHome("new");
    f.publish();
    const newer = f.head();
    runGit(f.source, ["checkout", "--detach", old]);
    const staleView: Git = (cwd, args) =>
      args[0] === "ls-remote" && args.includes(f.remote)
        ? `${old}\trefs/heads/main\n`
        : runGit(cwd, args);
    expect(() =>
      publishWiki({
        sourceDirectory: f.source,
        sourceRemote: f.remote,
        wikiRemote: f.wiki,
        sourceSha: old,
        repository: "fixture/WEFT",
        git: staleView,
      }),
    ).toThrow("PUBLISHED_SOURCE_NOT_ANCESTOR");
    expect(f.head()).toBe(newer);
  });

  it("an older workflow invocation resolves latest main and leaves a newer publication unchanged", () => {
    const f = fixture();
    const oldEventSha = f.sha;
    f.publish();
    f.changeHome("new main");
    const newest = f.publish();
    runGit(f.source, ["checkout", "--detach", oldEventSha]);
    // The same fetch/detached-checkout sequence as wiki.yml, using only a local remote.
    runGit(f.source, ["fetch", "--no-tags", "source", "refs/heads/main"]);
    const selected = runGit(f.source, ["rev-parse", "FETCH_HEAD"]).trim();
    runGit(f.source, ["checkout", "--detach", selected]);
    expect(selected).not.toBe(oldEventSha);
    expect(f.publish()).toMatchObject({
      result: "noop",
      sourceSha: selected,
      wikiSha: newest.wikiSha,
    });
  });

  it("requires freshness even for a no-op", () => {
    const f = fixture();
    const first = f.publish();
    let observations = 0;
    const racing: Git = (cwd, args) => {
      if (args[0] === "ls-remote" && args.includes(f.remote) && ++observations === 2)
        f.changeHome("advanced during no-op");
      return runGit(cwd, args);
    };
    expect(() => f.publish(racing)).toThrow("SOURCE_ADVANCED_BEFORE_PUSH");
    expect(f.head()).toBe(first.wikiSha);
  });

  it("rejects source advancement immediately before push; a rerun publishes latest", () => {
    const f = fixture();
    let observations = 0;
    const racing: Git = (cwd, args) => {
      if (args[0] === "ls-remote" && args.includes(f.remote) && ++observations === 2)
        f.changeHome("latest");
      return runGit(cwd, args);
    };
    expect(() => f.publish(racing)).toThrow("SOURCE_ADVANCED_BEFORE_PUSH");
    expect(f.head()).toBe(f.initialWiki);
    expect(f.publish()).toMatchObject({ result: "published", sourceSha: f.sha });
  });

  it("rejects destination advancement before push", () => {
    const f = fixture();
    let observations = 0;
    const racing: Git = (cwd, args) => {
      if (args[0] === "ls-remote" && args.includes(f.wiki) && ++observations === 2)
        f.externalChange("Notes.md", "Keep this.\n");
      return runGit(cwd, args);
    };
    expect(() => f.publish(racing)).toThrow("WIKI_ADVANCED_BEFORE_PUSH");
    expect(f.file("Notes.md")).toBe("Keep this.\n");
  });

  it("rejects a default branch change even if both branches point to the same revision", () => {
    const f = fixture();
    let observations = 0;
    const racing: Git = (cwd, args) => {
      if (args[0] === "ls-remote" && args.includes(f.wiki) && ++observations === 2) {
        runGit(f.source, [
          "--git-dir",
          f.wiki,
          "update-ref",
          "refs/heads/changed-default",
          f.initialWiki,
        ]);
        runGit(f.source, [
          "--git-dir",
          f.wiki,
          "symbolic-ref",
          "HEAD",
          "refs/heads/changed-default",
        ]);
      }
      return runGit(cwd, args);
    };
    expect(() => f.publish(racing)).toThrow("WIKI_ADVANCED_BEFORE_PUSH");
    expect(f.head()).toBe(f.initialWiki);
  });

  it("rejects an empty seed Home and a manifest that claims a traversal path", () => {
    const empty = fixture();
    empty.externalChange("Home.md", " \n");
    expect(() => empty.publish()).toThrow("EMPTY_BOOTSTRAP_HOME");
    const f = fixture();
    f.publish();
    const manifest: unknown = JSON.parse(f.file(MANIFEST));
    if (typeof manifest !== "object" || manifest === null)
      throw new Error("Missing fixture manifest");
    f.externalChange(
      MANIFEST,
      JSON.stringify({ ...manifest, pages: [{ path: "../Home.md", sha256: "0".repeat(64) }] }),
    );
    const before = f.head();
    expect(() => f.publish()).toThrow("INVALID_MANIFEST");
    expect(f.head()).toBe(before);
  });

  it("does not force a push over a destination conflict after the final check", () => {
    const f = fixture();
    const racing: Git = (cwd, args) => {
      if (args[0] === "push") f.externalChange("Notes.md", "Concurrent edit.\n");
      return runGit(cwd, args);
    };
    expect(() => f.publish(racing)).toThrow("PUSH_RESULT_UNCONFIRMED");
    expect(f.file("Notes.md")).toBe("Concurrent edit.\n");
    expect(() => f.file(MANIFEST)).toThrow();
  });

  it("reports push rejection and recovers with a fresh synchronization", () => {
    const f = fixture();
    const rejected: Git = (cwd, args) => {
      if (args[0] === "push") throw new Error("simulated rejection");
      return runGit(cwd, args);
    };
    expect(() => f.publish(rejected)).toThrow("PUSH_FAILED");
    expect(f.head()).toBe(f.initialWiki);
    expect(f.publish().result).toBe("published");
    expect(f.publish().result).toBe("noop");
  });

  it("confirms a lost push response only by exact remote HEAD", () => {
    const f = fixture();
    const lost: Git = (cwd, args) => {
      const result = runGit(cwd, args);
      if (args[0] === "push") throw new Error("response lost");
      return result;
    };
    expect(f.publish(lost)).toMatchObject({ result: "published", wikiSha: f.head() });
  });

  it.each([false, true])(
    "fails an unconfirmed remote result after push (lost response=%s) and safely resynchronizes",
    (lost) => {
      const f = fixture();
      let pushed = false;
      const unknown: Git = (cwd, args) => {
        if (pushed && args[0] === "ls-remote") throw new Error("remote unreadable");
        const result = runGit(cwd, args);
        if (args[0] === "push") {
          pushed = true;
          if (lost) throw new Error("response lost");
        }
        return result;
      };
      expect(() => f.publish(unknown)).toThrow("PUSH_RESULT_UNCONFIRMED");
      expect(f.head()).not.toBe(f.initialWiki);
      const confirmed = f.head();
      expect(f.publish()).toMatchObject({ result: "noop", wikiSha: confirmed });
    },
  );

  it("never exposes subprocess stderr in an error", () => {
    expect(() => runGit("/tmp", ["not-a-real-git-command", "sensitive-placeholder"])).toThrow(
      new WikiPublicationError("GIT_OPERATION_FAILED"),
    );
  });
});

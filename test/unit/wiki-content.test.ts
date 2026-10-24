import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  headingSlug,
  pageAnchors,
  readWikiSources,
  registeredCommands,
  validateGuide,
} from "../../scripts/wiki/content.js";

const guide = readWikiSources(resolve(import.meta.dirname, "../../docs/wiki"));
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bilingual Wiki content gate", () => {
  it("validates every page, language switch, sidebar, link, command and checked numeric fact", () => {
    expect(() => validateGuide(guide)).not.toThrow();
    expect(registeredCommands().map((command) => command.path)).toContain(
      "/message schedule recurrence-edit",
    );
  });

  it("accepts version guidance without a development-status label", () => {
    expect(guide.get("Home.md")).not.toContain("unreleased");
    expect(guide.get("Home-ja.md")).not.toContain("未リリース");
    expect(() => validateGuide(guide)).not.toThrow();
  });

  it.each([
    [
      "Home.md",
      [
        "WEFT",
        "initial MVP",
        "implemented",
        "features and commands",
        "canonical Markdown sources",
        "published to the GitHub Wiki",
        "WEFT version you deploy",
      ],
    ],
    [
      "Home-ja.md",
      [
        "WEFTの初期MVP",
        "実装されている機能とコマンド",
        "正本のMarkdownファイル",
        "そこからGitHub Wikiへ公開します",
        "導入済みのWEFTの版で利用できることを確認",
      ],
    ],
  ] as const)("identifies the application scope and canonical source in %s", (page, required) => {
    const guidance = guide.get(page)!.split('<a id="guide-version"></a>')[1]!;
    for (const fragment of required) expect(guidance).toContain(fragment);
    expect(guidance).toContain("`main`");
    expect(guidance).toContain("`docs/wiki/`");
    expect(guidance).toContain("https://github.com/cludewn/WEFT/tree/main/docs/wiki");
    expect(guidance).toContain("GitHub Wiki");
  });

  it.each([
    ["missing required topic", "Operations.md", undefined],
    ["missing Japanese pair", "Home-ja.md", undefined],
    [
      "missing language switch",
      "Configuration.md",
      (s: string) => s.replace("[日本語](Configuration-ja)", "日本語"),
    ],
    [
      "missing sidebar link",
      "_Sidebar.md",
      (s: string) => s.replace("(Commands-Thread-ja)", "(Commands-Thread)"),
    ],
    ["broken topic link", "Home.md", (s: string) => `${s}\n[missing](Does-Not-Exist)\n`],
    ["malformed topic link", "Home.md", (s: string) => `${s}\n[missing](Invalid Page)\n`],
    [
      "broken anchor",
      "Home-ja.md",
      (s: string) => `${s}\n[missing](Operations-ja#does-not-exist)\n`,
    ],
    ["path traversal link", "Home.md", (s: string) => `${s}\n[bad](../Home)\n`],
    [
      "missing operation",
      "Commands-Thread.md",
      (s: string) => s.replace("## /thread open", "## Removed operation"),
    ],
    [
      "wrong command family",
      "Commands-Thread.md",
      (s: string) => s.replace("## /thread open", "## /config open"),
    ],
    [
      "missing index operation",
      "Command-Reference-ja.md",
      (s: string) => s.replace("[`/thread open`]", "[removed]"),
    ],
    [
      "missing required argument",
      "Commands-Message.md",
      (s: string) => s.replace(/(\| `message`\s*\|\s*)Required/, "$1Optional"),
    ],
    [
      "missing optional argument",
      "Commands-Message-ja.md",
      (s: string) => s.replace("| `weekdays`", "| `days`"),
    ],
    ["missing choice", "Commands-Config.md", (s: string) => s.replace("`button-only`", "removed")],
    [
      "missing required field",
      "Commands-Config-ja.md",
      (s: string) => s.replace("**結果:**", "**省略:**"),
    ],
    [
      "wrong registered length",
      "Commands-Message.md",
      (s: string) => s.replace("exactly 16 ASCII", "exactly 17 ASCII"),
    ],
    ["obsolete command", "Home.md", (s: string) => `${s}\n/ping\n`],
    ["wrong grace", "Scheduled-Messages-ja.md", (s: string) => s.replace(/\| 60\s*\|/, "| 61 |")],
    ["wrong retention", "Audit-and-Privacy.md", (s: string) => s.replace(/\| 90\s*\|/, "| 91 |")],
    [
      "missing audit source",
      "Audit-and-Privacy-ja.md",
      (s: string) => s.replace(/\| managed_message_execution_failure_audits\s*\|/, "| missing |"),
    ],
    ["missing state", "Troubleshooting-ja.md", (s: string) => s.replaceAll("PARTIAL", "UNKNOWN")],
    [
      "missing English version section",
      "Home.md",
      (s: string) => s.replace('id="guide-version"', 'id="other-guidance"'),
    ],
    [
      "missing Japanese version section",
      "Home-ja.md",
      (s: string) => s.replace('id="guide-version"', 'id="other-guidance"'),
    ],
  ] as const)("rejects %s", (_label, page, mutate) => {
    const sources = new Map(guide);
    if (mutate === undefined) sources.delete(page);
    else {
      const original = sources.get(page)!;
      const changed = mutate(original);
      expect(changed).not.toBe(original);
      sources.set(page, changed);
    }
    expect(() => validateGuide(sources)).toThrow();
  });

  it.each([
    ["Home.md", /^Missing guide version guidance: Home$/],
    ["Home-ja.md", /^Missing guide version guidance: Home-ja$/],
  ] as const)("rejects missing application scope guidance in %s", (page, expectedError) => {
    const sources = new Map(guide);
    const original = sources.get(page)!;
    const marker = '<a id="guide-version"></a>';
    const sections = original.split(marker);
    expect(sections).toHaveLength(2);
    expect(sections[1]!.trim()).not.toBe("");
    const changed = `${sections[0]}${marker}\n`;
    expect(changed).not.toBe(original);
    expect(changed.split(marker)[1]!.trim()).toBe("");
    sources.set(page, changed);
    expect(() => validateGuide(sources)).toThrow(expectedError);
  });

  it("rejects missing channel choice", () => {
    expect(() => validateGuide(guide)).not.toThrow();
    const sources = new Map(guide);
    const page = "Commands-Config-ja.md";
    const original = sources.get(page)!;
    const section = original
      .split(/^## /m)
      .find((part) => part.startsWith("/config audit-log set\n"));
    expect(section).toBeDefined();
    const rows = section!.match(/^\|\s*`channel`\s*\|[^\n]*\|$/gm) ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toContain("アナウンス");
    const changedRow = row.replaceAll("アナウンス", "");
    expect(changedRow).not.toContain("アナウンス");
    expect(changedRow).toContain("テキスト");
    const changed = original.replace(section!, section!.replace(row, changedRow));
    expect(changed).not.toBe(original);
    sources.set(page, changed);
    expect(() => validateGuide(sources)).toThrow(
      /^Missing channel choice: \/config audit-log set$/,
    );
  });

  it("checks added pages too and rejects unsupported reference link syntax", () => {
    const sources = new Map(guide);
    sources.set("Extra.md", "# Extra\n\n[other](Extra-ja)\n\n## Note\nText.\n");
    expect(() => validateGuide(sources)).toThrow();
    sources.set("Extra-ja.md", "# 追加\n\n[other](Extra)\n\n## 注記\n本文。\n");
    sources.set(
      "_Sidebar.md",
      `${sources.get("_Sidebar.md")}\n[extra](Extra) · [追加](Extra-ja)\n`,
    );
    expect(() => validateGuide(sources)).not.toThrow();
    sources.set("Extra.md", `${sources.get("Extra.md")}\n[link]: Extra-ja\n`);
    expect(() => validateGuide(sources)).toThrow();
  });

  it("uses GitHub-style punctuation, Unicode and duplicate heading anchors, ignoring fenced examples", () => {
    expect(headingSlug("/thread close-after")).toBe("thread-close-after");
    expect(
      pageAnchors(
        '# /thread open\n## Result\n## Result\n## 結果の確認\n<a id="stable"></a>\n```md\n## Ignored\n```\n',
      ),
    ).toEqual(new Set(["thread-open", "result", "result-1", "結果の確認", "stable"]));
    expect(() => pageAnchors('# Result\n<a id="result"></a>\n')).toThrow();
  });
});

describe("Wiki source path and file safety", () => {
  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), "weft-wiki-content-"));
    temporary.push(path);
    return path;
  }
  it("rejects an empty source set", () => {
    expect(() => readWikiSources(directory())).toThrow();
  });
  it.each([
    "../bad.md",
    "home.md",
    "Home..md",
    ".Hidden.md",
    "_Footer.md",
    "Home.mdx",
    "A B.md",
    "Home%2fBad.md",
    "Home-ja-ja.md",
    "Extra-ja-Other.md",
  ])("rejects unsafe name %s", (name) => {
    const path = directory();
    // Traversal is tested at the validator boundary without writing outside the fixture.
    if (name.includes("/")) {
      const sources = new Map(guide).set(name, "# Unsafe\n");
      expect(() => validateGuide(sources)).toThrow();
    } else {
      writeFileSync(join(path, name), "# Invalid\n");
      expect(() => readWikiSources(path)).toThrow();
    }
  });
  it.each(["", " \n\t", "text\0content"])("rejects empty/NUL content %#", (content) => {
    const path = directory();
    writeFileSync(join(path, "Home.md"), content);
    expect(() => readWikiSources(path)).toThrow();
  });
  it("rejects invalid UTF-8, directories, file symlinks, root symlinks and case collisions", () => {
    const invalid = directory();
    writeFileSync(join(invalid, "Home.md"), Buffer.from([0xff]));
    expect(() => readWikiSources(invalid)).toThrow();
    const nested = directory();
    mkdirSync(join(nested, "Nested.md"));
    expect(() => readWikiSources(nested)).toThrow();
    const linked = directory();
    symlinkSync(join(invalid, "Home.md"), join(linked, "Home.md"));
    expect(() => readWikiSources(linked)).toThrow();
    const parent = directory();
    symlinkSync(invalid, join(parent, "wiki"));
    expect(() => readWikiSources(join(parent, "wiki"))).toThrow();
    const collision = directory();
    writeFileSync(join(collision, "Home-ja.md"), "text");
    writeFileSync(join(collision, "Home-Ja.md"), "text");
    expect(() => readWikiSources(collision)).toThrow();
  });
});

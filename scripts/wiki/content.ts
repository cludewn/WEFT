import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { commandDefinitions } from "../../src/commands.js";
import { AUDIT_RETENTION_SOURCES } from "../../src/audit/audit-retention-persistence.js";
import {
  AUDIT_RETENTION_BATCH_SIZE,
  AUDIT_RETENTION_DURATION_MS,
  AUDIT_RETENTION_SWEEP_INTERVAL_MS,
} from "../../src/audit/audit-retention-runtime.js";
import {
  RECURRING_MISSED_GRACE_MINUTES,
  RECURRING_RETRY_LIFETIME_MINUTES,
} from "../../src/messages/recurring-message.js";
import {
  SCHEDULED_MESSAGE_GRACE_MS,
  SCHEDULED_MESSAGE_MAX_RETRY_COUNT,
} from "../../src/messages/scheduled-message-execution.js";
import {
  MANAGED_MESSAGE_CONTENT_MAX_LENGTH,
  MANAGED_MESSAGE_EMBED_TITLE_MAX_LENGTH,
  MANAGED_MESSAGE_EMBED_DESCRIPTION_MAX_LENGTH,
  MANAGED_MESSAGE_EMBED_IMAGE_URL_MAX_LENGTH,
} from "../../src/messages/managed-message-payload.js";
import {
  BULK_CONFIRMATION_TTL_MS,
  BULK_PAGE_SIZE,
  BULK_TARGET_LIMIT,
} from "../../src/threads/bulk-thread-close.js";

export const REQUIRED_PAGES = [
  "Home",
  "Installation-and-Setup",
  "Configuration",
  "Thread-Lifecycle",
  "Automatic-Close",
  "Scheduled-Thread-Close",
  "Bulk-Thread-Close",
  "Managed-Messages",
  "Scheduled-Messages",
  "Timezones-and-Scheduling",
  "Link-Previews",
  "Audit-and-Privacy",
  "Operations",
  "Backup-and-Recovery",
  "Troubleshooting",
  "Command-Reference",
  "Commands-Config",
  "Commands-Thread",
  "Commands-Message",
] as const;

export const safePageName = (name: string): boolean =>
  /^(?:[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*|_Sidebar)\.md$/.test(name) && !name.includes("-ja-");

export const digest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");
export type WikiSources = ReadonlyMap<string, string>;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Flat, regular, nonempty UTF-8 Markdown only. Never follows a source symlink. */
export function readWikiSources(directory: string): Map<string, string> {
  requireCondition(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    "Unsafe Wiki source directory",
  );
  const names = readdirSync(directory).sort();
  requireCondition(names.length > 0 && names.length <= 200, "Empty or oversized Wiki source set");
  const sources = new Map<string, string>();
  const folded = new Set<string>();
  for (const name of names) {
    requireCondition(safePageName(name), "Invalid Wiki source page name");
    requireCondition(!folded.has(name.toLowerCase()), "Case-colliding Wiki pages");
    folded.add(name.toLowerCase());
    const path = join(directory, name);
    const stat = lstatSync(path);
    requireCondition(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000,
      "Unsafe Wiki source file",
    );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    requireCondition(
      content.trim().length > 0 && !content.includes("\0"),
      "Empty or invalid Wiki content",
    );
    sources.set(name, content);
  }
  return sources;
}

function proseOnly(content: string): string {
  let fence: string | undefined;
  return content
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return "";
      }
      return fence === undefined ? line : "";
    })
    .join("\n");
}

export function headingSlug(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
    .replace(/\s/g, "-");
}

export function pageAnchors(content: string): Set<string> {
  const prose = proseOnly(content);
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of prose.matchAll(/^#{1,6} (.+?)\s*#*$/gm)) {
    const slug = headingSlug(match[1]!);
    let ordinal = counts.get(slug) ?? 0;
    while (anchors.has(ordinal === 0 ? slug : `${slug}-${ordinal}`)) ordinal++;
    anchors.add(ordinal === 0 ? slug : `${slug}-${ordinal}`);
    counts.set(slug, ordinal + 1);
  }
  for (const match of prose.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)) {
    requireCondition(!anchors.has(match[1]!), "Duplicate Wiki anchor");
    anchors.add(match[1]!);
  }
  return anchors;
}

function links(content: string): string[] {
  const prose = proseOnly(content);
  // The guide intentionally uses inline Markdown links and explicit ASCII topic anchors.
  requireCondition(
    !/^\s*\[[^\]]+\]:/m.test(prose) && !/\[\[/.test(prose),
    "Use inline Markdown Wiki links",
  );
  const matches = [...prose.matchAll(/!?\[[^\]\n]+\]\(([^)\s]+)\)/g)];
  requireCondition(
    matches.length === [...prose.matchAll(/\]\(/g)].length,
    "Malformed or unsupported inline Wiki link",
  );
  return matches.map((match) => match[1]!);
}

type RegisteredOption = {
  name: string;
  type: number;
  required?: boolean | undefined;
  min_length?: number | undefined;
  max_length?: number | undefined;
  choices?: readonly { value: string | number }[] | undefined;
  channel_types?: readonly number[] | undefined;
  options?: readonly RegisteredOption[] | undefined;
};
export type RegisteredCommand = { path: string; options: readonly RegisteredOption[] };

export function registeredCommands(): RegisteredCommand[] {
  const commands: RegisteredCommand[] = [];
  function visit(path: string, options: readonly RegisteredOption[]): void {
    for (const option of options) {
      const current = `${path} ${option.name}`;
      if (option.type === 2) visit(current, option.options ?? []);
      else if (option.type === 1) commands.push({ path: current, options: option.options ?? [] });
    }
  }
  for (const command of commandDefinitions) visit(`/${command.name}`, command.options ?? []);
  return commands;
}

function validateCommands(sources: WikiSources, suffix: string): void {
  const labels =
    suffix === ""
      ? ["Purpose", "Access", "Arguments", "Example", "Results", "Constraints", "Related"]
      : ["目的", "権限と場所", "引数", "使用例", "結果", "制約", "関連"];
  const definitions = registeredCommands();
  const sections = new Map<string, string>();
  for (const family of ["Config", "Thread", "Message"]) {
    const page = sources.get(`Commands-${family}${suffix}.md`)!;
    const matches = [...page.matchAll(/^## (\/[^\n]+)\n/gm)];
    for (const [i, match] of matches.entries()) {
      requireCondition(!sections.has(match[1]!), "Duplicate command reference");
      requireCondition(
        match[1]!.startsWith(`/${family.toLowerCase()} `),
        "Command in wrong reference family",
      );
      sections.set(
        match[1]!,
        page.slice(match.index + match[0].length, matches[i + 1]?.index ?? page.length),
      );
    }
  }
  requireCondition(
    sections.size === definitions.length,
    "Command reference count differs from registration",
  );
  const index = sources.get(`Command-Reference${suffix}.md`)!;
  const indexPaths = [...index.matchAll(/\[`(\/[^`]+)`\]\(/g)].map((m) => m[1]!);
  requireCondition(
    indexPaths.length === definitions.length && new Set(indexPaths).size === definitions.length,
    "Command index coverage differs from registration",
  );
  for (const command of definitions) {
    const section = sections.get(command.path);
    requireCondition(
      section !== undefined && indexPaths.includes(command.path),
      `Missing command: ${command.path}${suffix}`,
    );
    for (const label of labels)
      requireCondition(
        section.includes(`**${label}:**`),
        `Missing command field: ${command.path} ${label}`,
      );
    requireCondition(
      section.includes(`\n${command.path}`),
      `Missing executable example: ${command.path}`,
    );
    const rows = [
      ...section.matchAll(/^\| `([a-z-]+)` \| (Required|Optional|必須|任意) \| (.+) \|$/gm),
    ];
    requireCondition(
      rows.length === command.options.length,
      `Option coverage differs: ${command.path}`,
    );
    for (const option of command.options) {
      const row = rows.find((m) => m[1] === option.name);
      const required =
        suffix === ""
          ? option.required
            ? "Required"
            : "Optional"
          : option.required
            ? "必須"
            : "任意";
      requireCondition(
        row !== undefined && row[2] === required,
        `Missing option requirement: ${command.path} ${option.name}`,
      );
      const input = row[3]!;
      const types =
        suffix === ""
          ? { 3: "String", 5: "Boolean", 7: "Channel" }
          : { 3: "文字列", 5: "真偽値", 7: "チャンネル" };
      requireCondition(
        input.includes(types[option.type as keyof typeof types] ?? "Unsupported"),
        `Missing input type: ${command.path} ${option.name}`,
      );
      for (const choice of option.choices ?? [])
        requireCondition(
          input.includes(`\`${choice.value}\``),
          `Missing option choice: ${command.path}`,
        );
      for (const length of [option.min_length, option.max_length]) {
        if (length !== undefined)
          requireCondition(input.includes(String(length)), `Missing input length: ${command.path}`);
      }
      for (const channel of option.channel_types ?? []) {
        const name = (
          suffix === ""
            ? { 0: "text", 5: "announcement", 15: "forum" }
            : { 0: "テキスト", 5: "アナウンス", 15: "フォーラム" }
        )[channel as 0 | 5 | 15];
        requireCondition(input.includes(name), `Missing channel choice: ${command.path}`);
      }
    }
  }
}

const facts = [
  ["Managed-Messages", "payload-content", MANAGED_MESSAGE_CONTENT_MAX_LENGTH],
  ["Managed-Messages", "payload-title", MANAGED_MESSAGE_EMBED_TITLE_MAX_LENGTH],
  ["Managed-Messages", "payload-description", MANAGED_MESSAGE_EMBED_DESCRIPTION_MAX_LENGTH],
  ["Managed-Messages", "payload-image", MANAGED_MESSAGE_EMBED_IMAGE_URL_MAX_LENGTH],
  ["Bulk-Thread-Close", "bulk-candidates", BULK_TARGET_LIMIT],
  ["Bulk-Thread-Close", "bulk-page", BULK_PAGE_SIZE],
  ["Bulk-Thread-Close", "bulk-session-minutes", BULK_CONFIRMATION_TTL_MS / 60_000],
  ["Scheduled-Messages", "one-time-grace", SCHEDULED_MESSAGE_GRACE_MS / 60_000],
  ["Scheduled-Messages", "recurring-grace", RECURRING_MISSED_GRACE_MINUTES],
  ["Scheduled-Messages", "recurring-retry-lifetime", RECURRING_RETRY_LIFETIME_MINUTES],
  ["Scheduled-Messages", "message-retries", SCHEDULED_MESSAGE_MAX_RETRY_COUNT],
  ["Audit-and-Privacy", "audit-source-count", AUDIT_RETENTION_SOURCES.length],
  ["Audit-and-Privacy", "audit-retention-days", AUDIT_RETENTION_DURATION_MS / 86_400_000],
  ["Audit-and-Privacy", "audit-sweep-hours", AUDIT_RETENTION_SWEEP_INTERVAL_MS / 3_600_000],
  ["Audit-and-Privacy", "audit-batch", AUDIT_RETENTION_BATCH_SIZE],
] as const;

/** Publication gate. Semantic translation equivalence still requires a human review. */
export function validateGuide(rawSources: WikiSources): void {
  // Prettier pads table cells. Their spacing is presentation, not part of the contract.
  const sources = new Map(
    [...rawSources].map(([name, content]) => [
      name,
      content.replace(
        /^\|.*\|$/gm,
        (line) =>
          `| ${line
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
            .join(" | ")} |`,
      ),
    ]),
  );
  requireCondition(sources.has("_Sidebar.md"), "Missing Wiki sidebar");
  const sidebarLinks = links(sources.get("_Sidebar.md")!);
  for (const page of REQUIRED_PAGES) {
    for (const suffix of ["", "-ja"])
      requireCondition(
        sources.has(`${page}${suffix}.md`),
        `Missing required page: ${page}${suffix}`,
      );
  }
  const anchors = new Map([...sources].map(([name, content]) => [name, pageAnchors(content)]));
  for (const [name, content] of sources) {
    requireCondition(safePageName(name) && content.trim().length > 0, "Invalid Wiki page");
    if (name !== "_Sidebar.md") {
      const page = name.slice(0, -3);
      const other = page.endsWith("-ja") ? page.slice(0, -3) : `${page}-ja`;
      requireCondition(
        sources.has(`${other}.md`) && links(content).includes(other),
        `Missing language switch: ${name}`,
      );
      requireCondition(sidebarLinks.includes(page), `Missing sidebar entry: ${name}`);
      requireCondition(
        /^# .+/m.test(content) && /^## .+/m.test(content),
        `Missing title/topic sections: ${name}`,
      );
    }
    for (const target of links(content)) {
      if (/^https:\/\//.test(target)) continue;
      const [page, fragment, extra] = target.split("#");
      requireCondition(
        extra === undefined && (page === "" || /^[A-Za-z][A-Za-z0-9-]*$/.test(page!)),
        `Invalid internal Wiki link in ${name}`,
      );
      const destination = page === "" ? name : `${page}.md`;
      requireCondition(sources.has(destination), `Broken Wiki link: ${name} -> ${target}`);
      if (fragment !== undefined)
        requireCondition(
          fragment.length > 0 && anchors.get(destination)!.has(decodeURIComponent(fragment)),
          `Broken Wiki anchor: ${name} -> ${target}`,
        );
    }
    requireCondition(
      !/\/ping\b|\/config closed-prefix value:|\/message schedule list page:/.test(content),
      `Obsolete command syntax in ${name}`,
    );
  }
  for (const suffix of ["", "-ja"]) {
    validateCommands(sources, suffix);
    for (const [page, key, expected] of facts) {
      const content = sources.get(`${page}${suffix}.md`)!;
      const marker = `<!-- fact:${key} -->`;
      requireCondition(
        content.split(marker).length === 2,
        `Missing/duplicate fact: ${key}${suffix}`,
      );
      const following = content.split(marker)[1]!.split("\n")[0]!;
      const actual = /^[^|\n]+ \| (\d+)(?:[^|\n]*) \|/.exec(following)?.[1];
      requireCondition(
        Number(actual) === expected,
        `Numeric fact differs from implementation: ${key}${suffix}`,
      );
    }
    const audit = sources.get(`Audit-and-Privacy${suffix}.md`)!;
    for (const source of AUDIT_RETENTION_SOURCES)
      requireCondition(audit.includes(`| ${source} |`), `Missing audit source: ${source}${suffix}`);
    const troubleshooting = sources.get(`Troubleshooting${suffix}.md`)!;
    for (const state of ["PENDING", "UNCONFIRMED", "PARTIAL", "Skipped"])
      requireCondition(
        troubleshooting.includes(`| ${state}`),
        `Missing result state: ${state}${suffix}`,
      );
    const versionGuidance =
      proseOnly(sources.get(`Home${suffix}.md`)!)
        .split('<a id="guide-version"></a>')[1]
        ?.split(/\n#{1,6} /)[0] ?? "";
    requireCondition(
      versionGuidance.includes("WEFT") &&
        (suffix === "" ? /\bversion\b/i : /版/).test(versionGuidance),
      `Missing guide version guidance: Home${suffix}`,
    );
  }
}

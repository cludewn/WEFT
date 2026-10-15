import { createHash } from "node:crypto";

export const MAX_VISIBLE_ITEMS = 3;
export const MAX_CANDIDATES_EXAMINED = 6;

export const LINK_PREVIEW_MODES = ["hybrid", "public-only", "button-only", "off"] as const;
export type LinkPreviewMode = (typeof LINK_PREVIEW_MODES)[number];
export const isLinkPreviewMode = (value: unknown): value is LinkPreviewMode =>
  LINK_PREVIEW_MODES.some((mode) => mode === value);
export type MessageLink = { guildId: string; channelId: string; messageId: string };
export const isSnowflake = (value: string): boolean =>
  /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export const originalUrl = (target: MessageLink): string =>
  `https://discord.com/channels/${target.guildId}/${target.channelId}/${target.messageId}`;
export const previewCustomId = (target: MessageLink): string =>
  `lp:1:${target.guildId}:${target.channelId}:${target.messageId}`;
export function parsePreviewCustomId(value: string): MessageLink | undefined {
  const parts = /^lp:1:([^:]+):([^:]+):([^:]+)$/.exec(value);
  if (!parts || value.length > 100 || !parts.slice(1).every(isSnowflake)) return;
  return { guildId: parts[1]!, channelId: parts[2]!, messageId: parts[3]! };
}

export function parseMessageLinks(content: string, guildId: string): MessageLink[] {
  const targets: MessageLink[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/https:\/\/[^\s<>"'[\]()]+/gi)) {
    const raw = match[0].replace(/[.,!;:。、「」]+$/u, "");
    const grammar =
      /^https:\/\/((?:(?:www|ptb|canary)\.)?discord(?:app)?\.com)\/channels\/([1-9][0-9]{0,19})\/([1-9][0-9]{0,19})\/([1-9][0-9]{0,19})(?:[?#][^\\\s]*)?$/i.exec(
        raw,
      );
    if (!grammar || raw.includes("\\")) continue;
    const [, host, guild, channel, message] = grammar;
    if (guild !== guildId || ![guild, channel!, message!].every(isSnowflake)) continue;
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.host !== host!.toLowerCase() ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== `/channels/${guild}/${channel}/${message}`
    )
      continue;
    const target = { guildId: guild, channelId: channel!, messageId: message! };
    const key = previewCustomId(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

export function previewNonce(source: MessageLink): string {
  return `lp_${createHash("sha256").update(`weft:link-preview:v3\0${source.guildId}\0${source.channelId}\0${source.messageId}`).digest("base64url").slice(0, 22)}`;
}

export type PreviewMessage = {
  author: string;
  avatar?: string;
  content: string;
  timestamp: string;
  attachments: { url: string; image: boolean; spoiler: boolean }[];
  forwarded: boolean;
};
export type PreviewEmbed = {
  description?: string;
  author?: { name: string; icon_url?: string };
  footer: { text: string };
  timestamp: string;
  image?: { url: string };
};
function clip(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum - 1;
  if (/[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return value.slice(0, end) + "…";
}
function plainMentions(value: string): string {
  return value
    .replace(/<@!?([0-9]+)>/g, "@user:$1")
    .replace(/<@&([0-9]+)>/g, "@role:$1")
    .replace(/<#([0-9]+)>/g, "#channel:$1")
    .replace(/@(everyone|here)/g, "@\u200b$1");
}
function boundedContent(content: string): string {
  // Omit spoiler spans altogether: truncation and malformed Markdown cannot expose them.
  return clip(plainMentions(content.replace(/\|\|[\s\S]*?(?:\|\||$)/g, "[spoiler omitted]")), 1500);
}
export function renderPreview(message: PreviewMessage, location: string): PreviewEmbed {
  const image = message.attachments.find((attachment) => attachment.image && !attachment.spoiler);
  const description = message.forwarded
    ? "No preview available."
    : boundedContent(message.content) || (image ? undefined : "No preview available.");
  return {
    ...(description ? { description } : {}),
    ...(!message.forwarded
      ? {
          author: {
            name: clip(plainMentions(message.author), 128),
            ...(message.avatar ? { icon_url: message.avatar } : {}),
          },
        }
      : {}),
    footer: previewFooter(location),
    timestamp: message.timestamp,
    ...(!message.forwarded && image ? { image: { url: image.url } } : {}),
  };
}
function previewFooter(location: string): PreviewEmbed["footer"] {
  return { text: clip(plainMentions(location), 128) };
}

export type PreviewState = "PUBLIC" | "RESTRICTED" | "UNCERTAIN" | "INELIGIBLE";
export type PreviewObservation =
  { state: "PUBLIC"; location: string } | { state: Exclude<PreviewState, "PUBLIC"> };
export type PreviewHelper = { target: MessageLink; ordinal: number };
export type PreviewOutput = {
  embeds: PreviewEmbed[];
  helpers: PreviewHelper[];
  targetCount: number;
  overflow: number;
};
export type PreviewSource = MessageLink & { content: string };
export type LinkPreviewBoundary = {
  sourceSendable: (source: PreviewSource) => Promise<boolean>;
  classify: (targets: MessageLink[]) => Promise<PreviewObservation[]>;
  authorize: (target: MessageLink, userId: string) => Promise<{ location: string } | undefined>;
  fetchMessage: (target: MessageLink) => Promise<PreviewMessage>;
  send: (source: PreviewSource, output: PreviewOutput, nonce: string) => Promise<void>;
};
export function createLinkPreviewService(dependencies: {
  readMode: (guildId: string) => Promise<LinkPreviewMode>;
  discord: LinkPreviewBoundary;
  log: (source: MessageLink, code: "PREVIEW_FAILED" | "SEND_UNCONFIRMED") => void;
}) {
  const active = new Set<string>();
  const { discord, readMode, log } = dependencies;
  return {
    async detect(source: PreviewSource): Promise<void> {
      const candidates = parseMessageLinks(source.content, source.guildId);
      const targets = candidates.slice(0, MAX_CANDIDATES_EXAMINED);
      const key = previewCustomId(source);
      if (!targets.length || active.has(key)) return;
      active.add(key);
      try {
        const mode = await readMode(source.guildId);
        if (mode === "off" || !(await discord.sourceSendable(source))) return;
        const eligible: (PreviewHelper & { embed?: PreviewEmbed })[] = [];
        const initial = mode === "button-only" ? [] : await discord.classify(targets);
        const prepared = await Promise.allSettled(
          targets.map(async (target, index) => {
            const observation = initial[index];
            if (observation?.state === "PUBLIC") {
              return {
                target,
                ordinal: index + 1,
                embed: renderPreview(await discord.fetchMessage(target), observation.location),
              };
            }
          }),
        );
        const automatic: { target: MessageLink; ordinal: number; embed: PreviewEmbed }[] = [];
        prepared.forEach((result, index) => {
          if (result.status === "fulfilled" && result.value) automatic.push(result.value);
          else if (
            mode === "button-only" ||
            (mode === "hybrid" && initial[index]?.state !== "INELIGIBLE")
          )
            eligible.push({ target: targets[index]!, ordinal: index + 1 });
        });
        // Finish preparation before fresh source and target observations in the same batch.
        // Settle every sibling even on failure so ingress owns all pre-send REST work.
        const [sourceCheck, targetCheck] = await Promise.allSettled([
          discord.sourceSendable(source),
          automatic.length
            ? discord.classify(automatic.map((item) => item.target))
            : Promise.resolve([]),
        ]);
        if (sourceCheck.status !== "fulfilled" || !sourceCheck.value) return;
        if (targetCheck.status !== "fulfilled") throw new Error("Unconfirmed targets");
        const final = targetCheck.value;
        automatic.forEach((item, index) => {
          const observation = final[index];
          if (observation?.state === "PUBLIC")
            eligible.push({
              ...item,
              embed: { ...item.embed, footer: previewFooter(observation.location) },
            });
          else if (mode === "hybrid" && observation?.state !== "INELIGIBLE")
            eligible.push({ target: item.target, ordinal: item.ordinal });
        });
        eligible.sort((left, right) => left.ordinal - right.ordinal);
        const visible = eligible.slice(0, MAX_VISIBLE_ITEMS);
        const overflow =
          Math.max(0, eligible.length - MAX_VISIBLE_ITEMS) + candidates.length - targets.length;
        const embeds = visible.flatMap((item) => (item.embed ? [item.embed] : []));
        const helpers = visible.flatMap((item) =>
          item.embed ? [] : [{ target: item.target, ordinal: item.ordinal }],
        );
        if (!visible.length && !overflow) return;
        // One bounded reply immediately follows fresh proof, without any intervening reads.
        try {
          await discord.send(
            source,
            { embeds, helpers, targetCount: candidates.length, overflow },
            previewNonce(source),
          );
        } catch {
          log(source, "SEND_UNCONFIRMED");
        }
      } catch {
        log(source, "PREVIEW_FAILED");
      } finally {
        active.delete(key);
      }
    },
    async preview(target: MessageLink, userId: string): Promise<PreviewEmbed | undefined> {
      try {
        const mode = await readMode(target.guildId);
        if (mode === "off" || mode === "public-only") return;
        const initial = await discord.authorize(target, userId);
        if (!initial) return;
        const embed = renderPreview(await discord.fetchMessage(target), initial.location);
        const final = await discord.authorize(target, userId);
        if (!final) return;
        return { ...embed, footer: previewFooter(final.location) };
      } catch {
        return;
      }
    },
  };
}
export type LinkPreviewService = ReturnType<typeof createLinkPreviewService>;

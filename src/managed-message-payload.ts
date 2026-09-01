export const MANAGED_MESSAGE_CONTENT_MAX_LENGTH = 2_000;
export const MANAGED_MESSAGE_EMBED_TITLE_MAX_LENGTH = 256;
export const MANAGED_MESSAGE_EMBED_DESCRIPTION_MAX_LENGTH = 4_000;
export const MANAGED_MESSAGE_EMBED_IMAGE_URL_MAX_LENGTH = 2_048;

export type ManagedMessageEmbed = {
  title?: string;
  description?: string;
  color?: number;
  imageUrl?: string;
};

export type ManagedMessagePayload = {
  content: string;
  embed: ManagedMessageEmbed | null;
};

export type ManagedMessagePayloadInput = {
  content: unknown;
  embed?: {
    title?: unknown;
    description?: unknown;
    color?: unknown;
    imageUrl?: unknown;
  } | null;
};

export type ManagedMessagePayloadValidationCode =
  | "EMPTY_CONTENT"
  | "CONTENT_TOO_LONG"
  | "EMBED_TITLE_TOO_LONG"
  | "EMBED_DESCRIPTION_TOO_LONG"
  | "EMBED_COLOR_INVALID"
  | "EMBED_COLOR_ONLY"
  | "EMBED_IMAGE_URL_TOO_LONG"
  | "EMBED_IMAGE_URL_INVALID";

export type ManagedMessagePayloadValidationResult =
  | { ok: true; payload: ManagedMessagePayload }
  | { ok: false; code: ManagedMessagePayloadValidationCode };

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function validateManagedMessagePayload(
  input: ManagedMessagePayloadInput,
): ManagedMessagePayloadValidationResult {
  if (typeof input.content !== "string") return { ok: false, code: "EMPTY_CONTENT" };
  if (input.content !== "" && input.content.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT" };
  }
  if ([...input.content].length > MANAGED_MESSAGE_CONTENT_MAX_LENGTH) {
    return { ok: false, code: "CONTENT_TOO_LONG" };
  }

  const rawEmbed = input.embed ?? {};
  const title = optionalTrimmedString(rawEmbed.title);
  if (title !== undefined && title.length > MANAGED_MESSAGE_EMBED_TITLE_MAX_LENGTH) {
    return { ok: false, code: "EMBED_TITLE_TOO_LONG" };
  }
  const description = optionalTrimmedString(rawEmbed.description);
  if (
    description !== undefined &&
    description.length > MANAGED_MESSAGE_EMBED_DESCRIPTION_MAX_LENGTH
  ) {
    return { ok: false, code: "EMBED_DESCRIPTION_TOO_LONG" };
  }

  let color: number | undefined;
  const rawColor = rawEmbed.color;
  if (rawColor !== undefined && rawColor !== null && rawColor !== "") {
    if (typeof rawColor === "number") {
      if (!Number.isInteger(rawColor) || rawColor < 0 || rawColor > 0xffffff) {
        return { ok: false, code: "EMBED_COLOR_INVALID" };
      }
      color = rawColor;
    } else if (typeof rawColor === "string" && /^#?[0-9a-fA-F]{6}$/.test(rawColor)) {
      color = Number.parseInt(rawColor.startsWith("#") ? rawColor.slice(1) : rawColor, 16);
    } else {
      return { ok: false, code: "EMBED_COLOR_INVALID" };
    }
  }

  let imageUrl: string | undefined;
  const rawImageUrl = rawEmbed.imageUrl;
  if (rawImageUrl !== undefined && rawImageUrl !== null) {
    if (typeof rawImageUrl !== "string") {
      return { ok: false, code: "EMBED_IMAGE_URL_INVALID" };
    }
    if (rawImageUrl.length > MANAGED_MESSAGE_EMBED_IMAGE_URL_MAX_LENGTH) {
      return { ok: false, code: "EMBED_IMAGE_URL_TOO_LONG" };
    }
    const trimmed = rawImageUrl.trim();
    if (trimmed.length > 0) {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        return { ok: false, code: "EMBED_IMAGE_URL_INVALID" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, code: "EMBED_IMAGE_URL_INVALID" };
      }
      imageUrl = parsed.href;
      if (imageUrl.length > MANAGED_MESSAGE_EMBED_IMAGE_URL_MAX_LENGTH) {
        return { ok: false, code: "EMBED_IMAGE_URL_TOO_LONG" };
      }
    }
  }

  const visible = title !== undefined || description !== undefined || imageUrl !== undefined;
  if (!visible && color !== undefined) return { ok: false, code: "EMBED_COLOR_ONLY" };
  const embed = visible
    ? {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(color === undefined ? {} : { color }),
        ...(imageUrl === undefined ? {} : { imageUrl }),
      }
    : null;
  if (input.content === "" && embed === null) return { ok: false, code: "EMPTY_CONTENT" };
  return { ok: true, payload: { content: input.content, embed } };
}

export function managedMessageEmbedsEqual(
  left: ManagedMessageEmbed | null,
  right: ManagedMessageEmbed | null,
): boolean {
  return (
    left?.title === right?.title &&
    left?.description === right?.description &&
    left?.color === right?.color &&
    left?.imageUrl === right?.imageUrl
  );
}

export function managedMessagePayloadsEqual(
  left: ManagedMessagePayload,
  right: ManagedMessagePayload,
): boolean {
  return left.content === right.content && managedMessageEmbedsEqual(left.embed, right.embed);
}

export function formatManagedMessageEmbedColor(color: number): string {
  return `#${color.toString(16).toUpperCase().padStart(6, "0")}`;
}

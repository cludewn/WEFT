import { describe, expect, it } from "vitest";

import {
  formatManagedMessageEmbedColor,
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
} from "../../src/managed-message-payload.js";

describe("managed message payload", () => {
  it.each([
    { content: "text", embed: null },
    { content: "", embed: { title: "Title" } },
    { content: "", embed: { description: "Description" } },
    { content: "", embed: { imageUrl: "https://example.invalid/image.png" } },
    { content: "text", embed: { title: "Title", color: "#00ff7f" } },
  ])("accepts canonical visible payload %#", (input) => {
    expect(validateManagedMessagePayload(input)).toMatchObject({ ok: true });
  });

  it("preserves non-empty content exactly and counts Unicode code points", () => {
    const content = `  ${"😀".repeat(1_996)}  `;
    expect(validateManagedMessagePayload({ content })).toEqual({
      ok: true,
      payload: { content, embed: null },
    });
    expect(validateManagedMessagePayload({ content: "😀".repeat(2_001) })).toEqual({
      ok: false,
      code: "CONTENT_TOO_LONG",
    });
  });

  it.each([
    { content: "", embed: null },
    { content: " \n\t", embed: { title: "visible" } },
  ])("rejects an empty or whitespace-content payload %#", (input) => {
    expect(validateManagedMessagePayload(input)).toMatchObject({
      ok: false,
      code: "EMPTY_CONTENT",
    });
  });

  it("outer-trims embed text, preserves internal whitespace, and drops blank fields", () => {
    expect(
      validateManagedMessagePayload({
        content: "",
        embed: {
          title: "  title  with  spaces  ",
          description: " \n description\nbody \n ",
          imageUrl: "   ",
        },
      }),
    ).toEqual({
      ok: true,
      payload: {
        content: "",
        embed: { title: "title  with  spaces", description: "description\nbody" },
      },
    });
  });

  it("uses builder-compatible UTF-16 limits for title and description", () => {
    expect(
      validateManagedMessagePayload({ content: "", embed: { title: "😀".repeat(128) } }),
    ).toMatchObject({ ok: true });
    expect(
      validateManagedMessagePayload({ content: "", embed: { title: "😀".repeat(129) } }),
    ).toEqual({ ok: false, code: "EMBED_TITLE_TOO_LONG" });
    expect(
      validateManagedMessagePayload({ content: "", embed: { description: "😀".repeat(2_001) } }),
    ).toEqual({ ok: false, code: "EMBED_DESCRIPTION_TOO_LONG" });
  });

  it.each([
    ["000000", 0],
    ["#abcdef", 0xabcdef],
    ["#FFFFFF", 0xffffff],
  ])("normalizes color %s", (input, color) => {
    expect(
      validateManagedMessagePayload({ content: "", embed: { title: "x", color: input } }),
    ).toEqual({ ok: true, payload: { content: "", embed: { title: "x", color } } });
    expect(formatManagedMessageEmbedColor(color)).toMatch(/^#[0-9A-F]{6}$/);
  });

  it.each([" #ABCDEF", "#ABCDEF ", "ABC", "#GGGGGG", "0xFFFFFF"])(
    "rejects non-exact color %s",
    (color) => {
      expect(validateManagedMessagePayload({ content: "text", embed: { color } })).toMatchObject({
        ok: false,
        code: "EMBED_COLOR_INVALID",
      });
    },
  );

  it("rejects color-only embeds while preserving numeric zero when visible", () => {
    expect(validateManagedMessagePayload({ content: "text", embed: { color: 0 } })).toEqual({
      ok: false,
      code: "EMBED_COLOR_ONLY",
    });
    expect(
      validateManagedMessagePayload({ content: "", embed: { title: "black", color: 0 } }),
    ).toMatchObject({ ok: true, payload: { embed: { color: 0 } } });
  });

  it("trims and WHATWG-normalizes absolute HTTP(S) image URLs", () => {
    expect(
      validateManagedMessagePayload({
        content: "",
        embed: { imageUrl: "  HTTPS://EXAMPLE.INVALID/a/../image.png?x=1  " },
      }),
    ).toEqual({
      ok: true,
      payload: {
        content: "",
        embed: { imageUrl: "https://example.invalid/image.png?x=1" },
      },
    });
  });

  it.each(["relative/path", "ftp://example.invalid/image", "//example.invalid/image"])(
    "rejects invalid image URL %s",
    (imageUrl) => {
      expect(validateManagedMessagePayload({ content: "text", embed: { imageUrl } })).toEqual({
        ok: false,
        code: "EMBED_IMAGE_URL_INVALID",
      });
    },
  );

  it("enforces both raw and serialized image URL length", () => {
    expect(
      validateManagedMessagePayload({
        content: "text",
        embed: { imageUrl: `https://example.invalid/${"x".repeat(2_048)}` },
      }),
    ).toEqual({ ok: false, code: "EMBED_IMAGE_URL_TOO_LONG" });
  });

  it("compares the complete canonical payload including absent embed properties", () => {
    const payload = { content: "text", embed: { title: "title", color: 0 } };
    expect(managedMessagePayloadsEqual(payload, { ...payload })).toBe(true);
    expect(
      managedMessagePayloadsEqual(payload, { content: "text", embed: { title: "title" } }),
    ).toBe(false);
    expect(managedMessagePayloadsEqual(payload, { content: "text", embed: null })).toBe(false);
  });
});

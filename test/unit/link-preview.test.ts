import { describe, expect, it, vi } from "vitest";
import {
  createLinkPreviewService,
  LINK_PREVIEW_MODES,
  MAX_VISIBLE_ITEMS,
  MAX_CANDIDATES_EXAMINED,
  originalUrl,
  parseMessageLinks,
  parsePreviewCustomId,
  previewCustomId,
  previewNonce,
  renderPreview,
} from "../../src/link-preview.js";
import type {
  LinkPreviewBoundary,
  LinkPreviewMode,
  PreviewMessage,
  PreviewObservation,
  PreviewState,
} from "../../src/link-preview.js";

const target = { guildId: "1", channelId: "2", messageId: "3" };
const source = { guildId: "1", channelId: "4", messageId: "5", content: originalUrl(target) };
const secret: PreviewMessage = {
  author: "SECRET_AUTHOR",
  avatar: "https://cdn.discordapp.com/SECRET_AVATAR",
  content: "SECRET_CONTENT",
  timestamp: "2026-01-01T00:00:00.000Z",
  attachments: [
    { url: "https://cdn.discordapp.com/SECRET_ATTACHMENT", image: true, spoiler: false },
  ],
  forwarded: false,
};
const location = "#general";
const observation = (state: PreviewState): PreviewObservation =>
  state === "PUBLIC" ? { state, location } : { state };
function fixture(mode: LinkPreviewMode = "hybrid", state: PreviewState = "PUBLIC") {
  const discord = {
    sourceSendable: vi.fn(() => Promise.resolve(true)),
    classify: vi.fn<LinkPreviewBoundary["classify"]>((targets) =>
      Promise.resolve(targets.map(() => observation(state))),
    ),
    authorize: vi.fn<LinkPreviewBoundary["authorize"]>(() => Promise.resolve({ location })),
    fetchMessage: vi.fn<LinkPreviewBoundary["fetchMessage"]>(() => Promise.resolve(secret)),
    send: vi.fn<LinkPreviewBoundary["send"]>(() => Promise.resolve()),
  };
  const readMode = vi.fn(() => Promise.resolve(mode));
  const log = vi.fn();
  return { discord, readMode, log, service: createLinkPreviewService({ discord, readMode, log }) };
}
describe("message link grammar", () => {
  it.each([
    "discord.com",
    "www.discord.com",
    "ptb.discord.com",
    "canary.discord.com",
    "discordapp.com",
    "www.discordapp.com",
    "ptb.discordapp.com",
    "canary.discordapp.com",
  ])("accepts %s and wrappers", (host) => {
    for (const wrapper of [
      (u: string) => u,
      (u: string) => `<${u}>`,
      (u: string) => `[link](${u})`,
      (u: string) => `See ${u}, please.`,
    ]) {
      expect(parseMessageLinks(wrapper(`https://${host}/channels/1/2/3?x=y#z`), "1")).toEqual([
        target,
      ]);
    }
  });
  it.each([
    "http://discord.com/channels/1/2/3",
    "https://evil.com/channels/1/2/3",
    "https://discord.com.evil/channels/1/2/3",
    "https://u@discord.com/channels/1/2/3",
    "https://discord.com:443/channels/1/2/3",
    "https://discord.com\\channels/1/2/3",
    "https://discord.com/channels/1/2/./3",
    "https://discord.com/channels/1/2/%33",
    "https://discord.com/channels/1/2/3/extra",
    "https://discord.com/channels/1/2/3/",
    "https://discord.com/channels/1/2/3x",
    "https://discord.com/channels/1/2/0",
    "https://discord.com/channels/1/2/03",
    "https://discord.com/channels/1/2/18446744073709551616",
    "https://discord.com/channels/@me/2/3",
    "https://discord.com/channels/6/2/3",
  ])("rejects %s", (url) => expect(parseMessageLinks(url, "1")).toEqual([]));
  it("accepts uint64 max and parses all distinct candidates in appearance order", () => {
    const input = `${source.content} https://canary.discordapp.com/channels/1/2/3?alias https://discord.com/channels/1/2/18446744073709551615 https://discord.com/channels/1/2/4 https://discord.com/channels/1/2/5`;
    expect(parseMessageLinks(input, "1").map((x) => x.messageId)).toEqual([
      "3",
      "18446744073709551615",
      "4",
      "5",
    ]);
  });
  it("validates owned custom IDs and uses stable bounded nonces", () => {
    expect(parsePreviewCustomId(previewCustomId(target))).toEqual(target);
    for (const id of [
      "lp:2:1:2:3",
      "lp:1:0:2:3",
      "lp:1:1:2:03",
      "lp:1:1:2:3:4",
      "lp:1:1:2:18446744073709551616",
    ])
      expect(parsePreviewCustomId(id)).toBeUndefined();
    expect(previewNonce(source)).toBe(previewNonce({ ...source }));
    expect(previewNonce(source).length).toBeLessThanOrEqual(25);
    expect(previewNonce({ ...source, messageId: "6" })).not.toBe(previewNonce(source));
  });
});
describe("preview modes and disclosure boundary", () => {
  for (const mode of LINK_PREVIEW_MODES)
    for (const state of ["PUBLIC", "RESTRICTED", "UNCERTAIN", "INELIGIBLE"] as const) {
      it(`${mode} / ${state}`, async () => {
        const f = fixture(mode, state);
        await f.service.detect(source);
        const shouldSend =
          mode === "button-only" ||
          (mode === "hybrid" && state !== "INELIGIBLE") ||
          (mode === "public-only" && state === "PUBLIC");
        expect(f.discord.send).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
        const automatic = (mode === "hybrid" || mode === "public-only") && state === "PUBLIC";
        expect(f.discord.fetchMessage).toHaveBeenCalledTimes(automatic ? 1 : 0);
        if (!automatic) expect(JSON.stringify(f.discord.send.mock.calls)).not.toContain("SECRET_");
        if (mode === "off" || mode === "button-only")
          expect(f.discord.classify).not.toHaveBeenCalled();
        if (mode === "off") expect(f.discord.sourceSendable).not.toHaveBeenCalled();
      });
    }
  it("prepares all content before final fresh proof and sends one mixed reply without protected helper metadata", async () => {
    const f = fixture();
    const order: string[] = [];
    const visits = new Map<string, number>();
    f.discord.classify.mockImplementation((targets) =>
      Promise.resolve(
        targets.map((t) => {
          const id = t.messageId;
          const n = (visits.get(id) ?? 0) + 1;
          visits.set(id, n);
          order.push(`state:${id}:${n}`);
          return observation(id === "6" && n === 2 ? "RESTRICTED" : "PUBLIC");
        }),
      ),
    );
    f.discord.fetchMessage.mockImplementation(() => {
      order.push("content");
      return Promise.resolve(secret);
    });
    f.discord.send.mockImplementation(() => {
      order.push("send");
      return Promise.resolve();
    });
    await f.service.detect({
      ...source,
      content: `${source.content} https://discord.com/channels/1/2/6`,
    });
    expect(order).toEqual([
      "state:3:1",
      "state:6:1",
      "content",
      "content",
      "state:3:2",
      "state:6:2",
      "send",
    ]);
    expect(f.discord.send).toHaveBeenCalledOnce();
    expect(f.discord.send.mock.calls[0]![1]).toEqual({
      embeds: [renderPreview(secret, location)],
      helpers: [{ target: { ...target, messageId: "6" }, ordinal: 2 }],
      targetCount: 2,
      overflow: 0,
    });
    expect(JSON.stringify(f.discord.send.mock.calls[0]![1].helpers)).not.toContain("SECRET_");
  });
  it.each(["RESTRICTED", "UNCERTAIN", "INELIGIBLE"] as const)(
    "drops final %s content",
    async (state) => {
      for (const mode of ["hybrid", "public-only"] as const) {
        const f = fixture(mode);
        f.discord.classify
          .mockResolvedValueOnce([observation("PUBLIC")])
          .mockResolvedValueOnce([observation(state)]);
        await f.service.detect(source);
        expect(JSON.stringify(f.discord.send.mock.calls)).not.toContain("SECRET_");
        expect(f.discord.send).toHaveBeenCalledTimes(
          mode === "hybrid" && state !== "INELIGIBLE" ? 1 : 0,
        );
      }
    },
  );
  it("bounds distinct links and sends mixed output in one reply with public targets counted in ordinals", async () => {
    const f = fixture();
    f.discord.classify.mockResolvedValueOnce([
      observation("RESTRICTED"),
      observation("PUBLIC"),
      observation("PUBLIC"),
      observation("PUBLIC"),
    ]);
    await f.service.detect({
      ...source,
      content: [3, 6, 7, 8]
        .map((id) => originalUrl({ ...target, messageId: String(id) }))
        .join(" "),
    });
    expect(f.discord.send).toHaveBeenCalledOnce();
    const output = f.discord.send.mock.calls[0]![1];
    expect(output.embeds).toHaveLength(2);
    expect(output.helpers).toEqual([{ target, ordinal: 1 }]);
    expect(output.targetCount).toBe(4);
    expect(output.overflow).toBe(1);
    expect(f.discord.classify.mock.calls[0]![0]).toHaveLength(4);
    expect(f.discord.fetchMessage).toHaveBeenCalledWith({ ...target, messageId: "8" });
    expect(f.discord.fetchMessage).toHaveBeenCalledTimes(3);
  });
  it("retains appearance ordinals and the same helper contract for button-only targets", async () => {
    const f = fixture("button-only");
    await f.service.detect({
      ...source,
      content: [3, 6, 7, 8]
        .map((id) => originalUrl({ ...target, messageId: String(id) }))
        .join(" "),
    });
    expect(f.discord.send).toHaveBeenCalledOnce();
    expect(f.discord.send.mock.calls[0]![1]).toEqual({
      embeds: [],
      targetCount: 4,
      overflow: 1,
      helpers: [3, 6, 7].map((id, index) => ({
        target: { ...target, messageId: String(id) },
        ordinal: index + 1,
      })),
    });
    expect(f.discord.classify).not.toHaveBeenCalled();
    expect(f.discord.fetchMessage).not.toHaveBeenCalled();
  });
  it("does not retry or split a mixed reply when its send is ambiguous", async () => {
    const f = fixture();
    f.discord.classify.mockResolvedValueOnce([observation("PUBLIC"), observation("RESTRICTED")]);
    f.discord.send.mockRejectedValueOnce(new Error("SECRET_CONTENT"));
    await f.service.detect({
      ...source,
      content: source.content + " " + originalUrl({ ...target, messageId: "6" }),
    });
    expect(f.discord.send).toHaveBeenCalledOnce();
    expect(f.discord.send.mock.calls[0]![1].embeds).toHaveLength(1);
    expect(f.discord.send.mock.calls[0]![1].helpers).toHaveLength(1);
    expect(f.log).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("SECRET_");
  });
  it("starts independent content reads together and waits for a slow sibling after failure", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.discord.fetchMessage.mockImplementation(async (link) => {
      if (link.messageId === "3") throw new Error("SECRET_CONTENT");
      await gate;
      return secret;
    });
    const detection = f.service.detect({
      ...source,
      content: source.content + " " + originalUrl({ ...target, messageId: "6" }),
    });
    await vi.waitFor(() => expect(f.discord.fetchMessage).toHaveBeenCalledTimes(2));
    expect(f.discord.classify).toHaveBeenCalledOnce();
    expect(f.discord.send).not.toHaveBeenCalled();
    release();
    await detection;
    expect(f.discord.classify).toHaveBeenCalledTimes(2);
    expect(f.discord.send).toHaveBeenCalledOnce();
    expect(f.discord.send.mock.calls[0]![1].embeds).toHaveLength(1);
    expect(f.discord.send.mock.calls[0]![1].helpers).toHaveLength(1);
    expect(JSON.stringify(f.discord.send.mock.calls[0]![1].helpers)).not.toContain("SECRET_");
  });
  it("uses final fresh location in an authorized button preview", async () => {
    const f = fixture("button-only");
    f.discord.authorize
      .mockResolvedValueOnce({ location: "#old-name" })
      .mockResolvedValueOnce({ location: "#current-name" });
    expect((await f.service.preview(target, "9"))?.footer.text).toBe("#current-name");
    expect(f.discord.authorize).toHaveBeenCalledTimes(2);
  });
  it("does not access targets when source cannot be sent to", async () => {
    const f = fixture();
    f.discord.sourceSendable.mockResolvedValue(false);
    await f.service.detect(source);
    expect(f.discord.classify).not.toHaveBeenCalled();
    expect(f.discord.send).not.toHaveBeenCalled();
  });
  it.each(["false", "rejection"])(
    "fails closed on final source %s after preparing content",
    async (failure) => {
      const f = fixture();
      f.discord.sourceSendable.mockResolvedValueOnce(true);
      if (failure === "false") f.discord.sourceSendable.mockResolvedValueOnce(false);
      else f.discord.sourceSendable.mockRejectedValueOnce(new Error("SECRET_FAILURE"));
      await f.service.detect(source);
      expect(f.discord.fetchMessage).toHaveBeenCalledOnce();
      expect(f.discord.sourceSendable).toHaveBeenCalledTimes(2);
      expect(f.discord.classify).toHaveBeenCalledTimes(2);
      expect(f.discord.send).not.toHaveBeenCalled();
      expect(JSON.stringify(f.log.mock.calls)).not.toContain("SECRET_");
    },
  );
  it.each(["source", "target"] as const)(
    "awaits the slow final %s sibling even when the other check fails",
    async (slow) => {
      const f = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.discord.sourceSendable.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
        if (slow === "source") await gate;
        else throw new Error("SECRET_FAILURE");
        return true;
      });
      f.discord.classify
        .mockResolvedValueOnce([observation("PUBLIC")])
        .mockImplementationOnce(async () => {
          if (slow === "target") await gate;
          else throw new Error("SECRET_FAILURE");
          return [observation("PUBLIC")];
        });
      let finished = false;
      const detection = f.service.detect(source).then(() => {
        finished = true;
      });
      await vi.waitFor(() => {
        expect(f.discord.sourceSendable).toHaveBeenCalledTimes(2);
        expect(f.discord.classify).toHaveBeenCalledTimes(2);
      });
      expect(finished).toBe(false);
      expect(f.discord.send).not.toHaveBeenCalled();
      release();
      await detection;
      expect(f.discord.send).not.toHaveBeenCalled();
    },
  );
  it("skips concurrent duplicate events and never replays an ambiguous send", async () => {
    const f = fixture();
    let finish!: () => void;
    f.discord.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.service.detect(source);
    await vi.waitFor(() => expect(f.discord.send).toHaveBeenCalledOnce());
    await f.service.detect(source);
    expect(f.discord.send).toHaveBeenCalledOnce();
    finish();
    await first;
    f.discord.send.mockRejectedValue(new Error("SECRET_CONTENT"));
    await f.service.detect(source);
    expect(f.log).toHaveBeenCalledWith(source, "SEND_UNCONFIRMED");
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("SECRET_");
    expect(f.discord.send).toHaveBeenCalledTimes(2);
  });
  it.each(["off", "public-only"] as const)(
    "rejects old buttons in %s before any target request",
    async (mode) => {
      const f = fixture(mode);
      expect(await f.service.preview(target, "9")).toBeUndefined();
      expect(f.discord.authorize).not.toHaveBeenCalled();
      expect(f.discord.fetchMessage).not.toHaveBeenCalled();
    },
  );
  it("revalidates after rendering and fails generically for revocation, deletion and REST failure", async () => {
    const f = fixture();
    f.discord.authorize.mockResolvedValueOnce({ location }).mockResolvedValueOnce(undefined);
    expect(await f.service.preview(target, "9")).toBeUndefined();
    expect(f.discord.authorize).toHaveBeenCalledTimes(2);
    f.discord.authorize.mockResolvedValue(undefined);
    f.discord.fetchMessage.mockClear();
    expect(await f.service.preview(target, "9")).toBeUndefined();
    expect(f.discord.fetchMessage).not.toHaveBeenCalled();
    f.discord.authorize.mockResolvedValue({ location });
    f.discord.fetchMessage.mockRejectedValue(new Error("SECRET_CONTENT"));
    expect(await f.service.preview(target, "9")).toBeUndefined();
    f.discord.fetchMessage.mockResolvedValue(secret);
    expect(await f.service.preview(target, "9")).toEqual(renderPreview(secret, location));
  });
});
describe("bounded pure renderer", () => {
  it("renders identity, image, timestamp and readable location without labels or omission counts", () => {
    const output = renderPreview(secret, location);
    expect(output.author).toEqual({ name: secret.author, icon_url: secret.avatar });
    expect(output.image?.url).toBe(secret.attachments[0]?.url);
    expect(output.timestamp).toBe(secret.timestamp);
    expect(output.footer.text).toBe(location);
    expect(JSON.stringify(output)).not.toMatch(/WEFT|Channel|omitted|embeds|stickers/);
    expect(output).not.toHaveProperty("title");
  });
  it("keeps the first eligible image and omits all remaining image/attachment counts", () => {
    const output = renderPreview(
      {
        ...secret,
        attachments: [
          { url: "https://cdn.discordapp.com/spoiler.png", image: true, spoiler: true },
          ...secret.attachments,
          { url: "https://cdn.discordapp.com/second.png", image: true, spoiler: false },
          { url: "https://cdn.discordapp.com/file.txt", image: false, spoiler: false },
        ],
      },
      location,
    );
    expect(output.image?.url).toBe(secret.attachments[0]!.url);
    expect(JSON.stringify(output)).not.toMatch(
      /images omitted|attachments omitted|files omitted|embeds omitted|stickers omitted|second.png|file.txt|spoiler.png|WEFT message previews?/,
    );
  });
  it("does not inline spoiler attachments or identify a forwarder as a snapshot author", () => {
    expect(
      renderPreview(
        { ...secret, attachments: [{ ...secret.attachments[0]!, spoiler: true }] },
        location,
      ).image,
    ).toBeUndefined();
    const output = renderPreview({ ...secret, forwarded: true }, location);
    expect(output.author).toBeUndefined();
    expect(output.image).toBeUndefined();
    expect(output.description).not.toContain(secret.content);
  });
  it("bounds UTF-16 without breaking surrogates, spoilers, aggregate text or enriching mentions", () => {
    const output = renderPreview(
      {
        ...secret,
        author: "😀".repeat(100),
        content: "@everyone <@1> <@&2> <#3> " + "😀".repeat(730) + "||SECRET_SPOILER",
      },
      "x".repeat(500),
    );
    expect(output.description).not.toContain("SECRET_SPOILER");
    expect(output.description).not.toMatch(/<[@#]/);
    expect(output.description).not.toContain("@everyone");
    for (const [value, max] of [
      [output.description!, 1500],
      [output.author!.name, 128],
      [output.footer.text, 128],
    ] as const) {
      expect(value.length).toBeLessThanOrEqual(max);
      expect(value.isWellFormed()).toBe(true);
    }
    expect(
      (output.description!.length + output.author!.name.length + output.footer.text.length) * 3,
    ).toBeLessThanOrEqual(6000);
    expect(
      renderPreview({ ...secret, content: "||SECRET_SPOILER|| after" }, location).description,
    ).toBe("[spoiler omitted] after");
    expect(renderPreview({ ...secret, content: "" }, location).description).toBeUndefined();
    expect(renderPreview({ ...secret, content: "", attachments: [] }, location).description).toBe(
      "No preview available.",
    );
  });
});

describe("separate visible and examination limits", () => {
  const links = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...target, messageId: String(index + 1) }));
  it("uses fixed three-visible and six-examined limits", () => {
    expect(MAX_VISIBLE_ITEMS).toBe(3);
    expect(MAX_CANDIDATES_EXAMINED).toBe(6);
  });
  it.each([
    {
      states: ["PUBLIC", "PUBLIC", "RESTRICTED", "PUBLIC"] as const,
      displayed: [1, 2, 4],
      more: 0,
    },
    {
      states: ["PUBLIC", "RESTRICTED", "PUBLIC", "RESTRICTED", "PUBLIC"] as const,
      displayed: [1, 3, 5],
      more: 0,
    },
    {
      states: ["PUBLIC", "PUBLIC", "RESTRICTED", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 2, 4],
      more: 1,
    },
    { states: ["PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC"] as const, displayed: [1, 2, 3], more: 1 },
    {
      states: ["PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 2, 3],
      more: 2,
    },
    {
      states: ["PUBLIC", "UNCERTAIN", "INELIGIBLE", "PUBLIC", "PUBLIC"] as const,
      displayed: [1, 4, 5],
      more: 0,
    },
  ])(
    "fills public-only slots and counts eligible overflow: $states",
    async ({ states, displayed, more }) => {
      const f = fixture("public-only");
      const targets = links(states.length);
      f.discord.classify.mockResolvedValueOnce(states.map(observation));
      f.discord.fetchMessage.mockImplementation((link) =>
        Promise.resolve({
          ...secret,
          content: `public-${link.messageId}`,
        }),
      );
      await f.service.detect({ ...source, content: targets.map(originalUrl).join(" ") });
      expect(f.discord.send).toHaveBeenCalledOnce();
      const output = f.discord.send.mock.calls[0]![1];
      expect(output.embeds.map((embed) => embed.description)).toEqual(
        displayed.map((index) => `public-${index}`),
      );
      expect(output.helpers).toEqual([]);
      expect(output.overflow).toBe(more);
      expect(output.targetCount).toBe(states.length);
      expect(f.discord.classify.mock.calls[0]![0]).toEqual(targets);
      targets.forEach((link, index) => {
        if (states[index] === "PUBLIC") expect(f.discord.fetchMessage).toHaveBeenCalledWith(link);
        else expect(f.discord.fetchMessage).not.toHaveBeenCalledWith(link);
      });
    },
  );
  it("skips age-ineligible hybrid candidates without losing source ordinals or slots", async () => {
    const f = fixture();
    f.discord.classify.mockResolvedValueOnce(
      ["PUBLIC", "INELIGIBLE", "RESTRICTED", "PUBLIC"].map((state) =>
        observation(state as PreviewState),
      ),
    );
    f.discord.fetchMessage.mockImplementation((link) =>
      Promise.resolve({
        ...secret,
        content: `public-${link.messageId}`,
      }),
    );
    await f.service.detect({ ...source, content: links(4).map(originalUrl).join(" ") });
    expect(f.discord.send).toHaveBeenCalledOnce();
    const output = f.discord.send.mock.calls[0]![1];
    expect(output.embeds.map((embed) => embed.description)).toEqual(["public-1", "public-4"]);
    expect(output.helpers).toEqual([{ target: links(4)[2], ordinal: 3 }]);
    expect(output.overflow).toBe(0);
    expect(output.targetCount).toBe(4);
  });
  it.each(["RESTRICTED", "UNCERTAIN", "INELIGIBLE"] as const)(
    "refills public-only slots and excludes final %s from overflow",
    async (state) => {
      const f = fixture("public-only");
      f.discord.classify
        .mockResolvedValueOnce(links(5).map(() => observation("PUBLIC")))
        .mockResolvedValueOnce(
          [state, "PUBLIC", "PUBLIC", "PUBLIC", "PUBLIC"].map((value) =>
            observation(value as PreviewState),
          ),
        );
      f.discord.fetchMessage.mockImplementation((link) =>
        Promise.resolve({
          ...secret,
          content: `public-${link.messageId}`,
        }),
      );
      await f.service.detect({ ...source, content: links(5).map(originalUrl).join(" ") });
      const output = f.discord.send.mock.calls[0]![1];
      expect(output.embeds.map((embed) => embed.description)).toEqual([
        "public-2",
        "public-3",
        "public-4",
      ]);
      expect(output.overflow).toBe(1);
      expect(f.discord.classify.mock.calls[1]![0]).toEqual(links(5));
    },
  );
  it.each(LINK_PREVIEW_MODES)("bounds eight candidates in %s", async (mode) => {
    const f = fixture(mode);
    const targets = links(8);
    await f.service.detect({ ...source, content: targets.map(originalUrl).join(" ") });
    if (mode === "off") {
      expect(f.discord.sourceSendable).not.toHaveBeenCalled();
      expect(f.discord.classify).not.toHaveBeenCalled();
      expect(f.discord.fetchMessage).not.toHaveBeenCalled();
      expect(f.discord.send).not.toHaveBeenCalled();
      return;
    }
    expect(f.discord.send).toHaveBeenCalledOnce();
    const output = f.discord.send.mock.calls[0]![1];
    expect(output.embeds.length + output.helpers.length).toBe(3);
    expect(output.targetCount).toBe(8);
    expect(output.overflow).toBe(5);
    if (mode === "button-only") {
      expect(f.discord.classify).not.toHaveBeenCalled();
      expect(f.discord.fetchMessage).not.toHaveBeenCalled();
      expect(output.helpers.map((item) => item.ordinal)).toEqual([1, 2, 3]);
    } else {
      expect(f.discord.classify).toHaveBeenCalledTimes(2);
      for (const [examined] of f.discord.classify.mock.calls)
        expect(examined).toEqual(targets.slice(0, 6));
      expect(f.discord.fetchMessage).toHaveBeenCalledTimes(6);
      for (const unexamined of targets.slice(6))
        expect(f.discord.fetchMessage).not.toHaveBeenCalledWith(unexamined);
    }
  });
  it.each(["hybrid", "public-only"] as const)(
    "sends only syntactic overflow when the first six are ineligible in %s",
    async (mode) => {
      const f = fixture(mode, "INELIGIBLE");
      await f.service.detect({ ...source, content: links(8).map(originalUrl).join(" ") });
      expect(f.discord.send).toHaveBeenCalledOnce();
      expect(f.discord.send.mock.calls[0]![1]).toEqual({
        embeds: [],
        helpers: [],
        targetCount: 8,
        overflow: 2,
      });
      expect(f.discord.fetchMessage).not.toHaveBeenCalled();
      expect(f.discord.classify).toHaveBeenCalledOnce();
      expect(f.discord.classify.mock.calls[0]![0]).toHaveLength(6);
      expect(JSON.stringify([f.discord.send.mock.calls, f.log.mock.calls])).not.toContain(
        "SECRET_",
      );
    },
  );
});

import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";

import { isSupportedThreadType } from "../../src/thread-discord.js";

describe("Discord thread support", () => {
  it("supports public, private, announcement, and forum-post thread types", () => {
    expect(isSupportedThreadType(ChannelType.PublicThread)).toBe(true);
    expect(isSupportedThreadType(ChannelType.PrivateThread)).toBe(true);
    expect(isSupportedThreadType(ChannelType.AnnouncementThread)).toBe(true);
    // Discord represents forum posts as public threads.
    expect(isSupportedThreadType(ChannelType.PublicThread)).toBe(true);
  });

  it("rejects non-thread channel types", () => {
    expect(isSupportedThreadType(ChannelType.GuildText)).toBe(false);
    expect(isSupportedThreadType(ChannelType.GuildForum)).toBe(false);
  });
});

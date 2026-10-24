# Link previews

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Link-Previews-ja)

When someone posts a supported same-server Discord message link, WEFT can show the linked message or offer a button to view it. This helps readers follow a discussion without immediately leaving the channel.

The **source channel** is where someone posts the link and WEFT replies. The **target** is the original linked message and its channel or thread. A server administrator selects the mode; WEFT chooses the output for each link using that mode and the current access/age checks it requires. Readers do not select an automatic-versus-button mode for each link.

<a id="visible-previews-and-buttons"></a>

## Understand what readers see

| Output                 | Visibility in the source channel                                   | How to view or investigate                                                                                 |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Automatic embed        | A copy of the content is visible to readers of the source channel. | Read the copy in WEFT’s reply. There is no Open original button.                                           |
| Generic Preview button | Only the button is visible; protected content is not shown.        | Click it; WEFT checks your current access and shows an authorized preview only to you, with Open original. |
| No output              | No WEFT preview or button is shown.                                | Check mode, link support and access conditions below.                                                      |

A button does not prove the target exists or that you can read it. It reveals no protected name, author or content. Unavailable or unauthorized clicks share a generic failure, so the error does not disclose the target’s existence.

**Published previews are point-in-time copies.** Later edits, deletion or permission changes do not update or remove them. Decide whether automatic copies are appropriate before choosing a mode. Button-only still cannot retract content someone has viewed or copied.

<a id="choose-a-mode"></a>

## Configure a mode and test a link

The mode applies to the **whole Discord server**. Changing or inspecting it requires Manage Server; readers use Preview buttons according to their current access to the linked message. A button does not grant access.

Choose how WEFT should respond to new links:

| Choice in `value`                                | Proven publicly readable target | Restricted or uncertain target | Confirmed age-restricted target             |
| ------------------------------------------------ | ------------------------------- | ------------------------------ | ------------------------------------------- |
| Automatic previews + buttons (`hybrid`, default) | Automatic embed                 | Generic Preview button         | Omitted                                     |
| Automatic public previews only (`public-only`)   | Automatic embed                 | Omitted                        | Omitted                                     |
| Preview buttons only (`button-only`)             | Generic button                  | Generic button                 | Generic button without target investigation |
| Off (`off`)                                      | Nothing                         | Nothing                        | Nothing                                     |

For example, to require readers to request previews individually:

1. Select [`/config link-preview mode`](Commands-Config#config-link-preview-mode). In `value`, **select Preview buttons only** (value: `button-only`), then run it. Use the offered choice, not free text.
2. Read the saved/unchanged response, then run [`/config link-preview show`](Commands-Config#config-link-preview-show) with no options and verify the saved mode.
3. Use Discord’s **Copy Message Link** on a message, then post the link as a new ordinary human message in a supported channel in the same server. Check the output against the table above; bot, webhook and system posts do not trigger detection.
4. If a Preview button appears, click it. An authorized result is shown only to you and includes **Open original**. A generic failure does not tell you whether the target exists or why access was unavailable.

Detection requires Message Content Intent enabled in the Developer Portal and WEFT’s source-channel read/send/embed permissions. If there is no output, check these prerequisites, the saved mode and [supported links](#use-a-message-link), then follow [preview troubleshooting](Troubleshooting#previews).

In `button-only`, no target existence, permission or age lookup happens until click. `off` performs no target requests or output. Existing buttons fail when the current mode is `off` or `public-only`. **Mode changes do not remove old copies.** [Access and age checks](#access-privacy-and-copies) explain why an automatic preview may become a button or be omitted.

<a id="use-a-message-link"></a>

## Supported links and display limits

Supported links use HTTPS and `/channels/<server-id>/<channel-id>/<message-id>` on `discord.com` or `discordapp.com`, including `www`, `ptb` and `canary` prefixes. Cross-server links and DMs are ignored. Plain links, angle wrappers and Markdown destinations are recognized; duplicate targets are counted once.

Malformed paths, extra segments, trailing slashes, backslashes, dot segments, explicit ports, credentials and encoded IDs are rejected. IDs must be canonical positive decimal values within uint64 range, with no leading zero and at most 20 digits. Query strings/fragments do not change target identity.

- WEFT investigates at most 6 distinct candidates and displays at most 3 preview/button items in one reply.
- In `public-only`, restricted/uncertain, age-ineligible and unreadable messages do not use a visible slot. In `hybrid`, a generic button can use a slot; confirmed age-ineligible targets cannot.
- `Preview N` labels follow original link order, including omitted and automatically shown items. A single distinct supported source link uses `Preview`. Buttons follow all embeds.
- `+N more` counts eligible examined items omitted by the visible limit, plus unexamined links beyond 6. Examined policy-excluded items are not counted. Unexamined overflow does not establish existence or access; a count-only reply is possible. `off` has no overflow output.

<a id="access-privacy-and-copies"></a>

## Access and age checks

Automatic display requires fresh conservative evidence of public view/history access. WEFT’s own access is insufficient. Private threads are never automatic.

For public proof, WEFT checks the fresh `@everyone` role and direct target/parent overwrites. Everyone must retain View Channel and Read Message History, and no other role/member overwrite may deny either. Missing or uncertain permission data cannot prove public access. Category overwrites are not applied a second time. This conservative test can produce a button even when a particular reader can access the message.

Clicks check fresh user permissions and WEFT access separately. Private threads also require current user membership or effective Manage Threads. Archived/locked targets can be read without joining, unarchiving or unlocking.

The target, or a thread’s direct parent, must be explicitly non-age-restricted. Unknown age state fails closed. Owner, Administrator, Manage Threads and membership confer no exception. Access and age are checked again immediately before output, but reading Discord and sending the preview happen separately, so permissions can change between them.

<a id="preview-content"></a>

## What a successful preview includes

Authorized previews contain bounded text, author/avatar, location, timestamp and at most one eligible non-spoiler image attachment. Text spoilers are omitted and mentions are suppressed. Other attachments, original embeds, stickers, polls, voice, components and forwarded snapshots are omitted. Referenced replies are not additionally fetched. Otherwise unsupported empty content uses a generic fallback; an image-only preview needs no fallback text.

WEFT creates embeds, not native forwards or impersonating webhooks. Preview execution/clicks have no persistent WEFT history or audit; mode changes do.

<a id="source-thread-and-language-behavior"></a>

## Source threads and language

WEFT does not reply in archived/locked source threads or explicitly join, leave, unarchive or unlock them. Sending in an active public/announcement/forum-post source may add WEFT as a member through normal Discord behavior. A private source requires existing bot membership even with Manage Threads or Administrator. If the source message disappears, WEFT does not fall back to an unreferenced send.

Initial buttons use the available source server’s language, with English fallback. Each click’s response and Open original use that interaction’s language (`ja` for Japanese, otherwise English). Existing labels do not change after language changes or restart; test a newly generated reply.

For problems, see [Troubleshooting](Troubleshooting#previews). Exact setting commands: [`mode`](Commands-Config#config-link-preview-mode), [`show`](Commands-Config#config-link-preview-show).

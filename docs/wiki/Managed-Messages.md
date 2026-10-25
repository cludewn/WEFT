# Managed messages

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Managed-Messages-ja)

A **managed message** is a message sent by WEFT and recorded in WEFT so administrators can edit it later. Use it for announcements whose wording may need to change. Being authored by the bot alone does not establish a management record.

An **embed** is a formatted card that can contain a title, description or image. Choose plain text, one supported embed, or both. For example:

| Example           | Message content    | Embed fields                                                                     |
| ----------------- | ------------------ | -------------------------------------------------------------------------------- |
| Text announcement | `Meeting at 09:30` | Leave blank.                                                                     |
| Text with a card  | `Meeting at 09:30` | Title `Weekly meeting`, description `Agenda in the pinned post`, color `#3366CC` |
| Card only         | Leave blank.       | Title `Maintenance complete`                                                     |

The form offers Message content, embed title, description, color and image URL. Attachments and multiple authored embeds are not supported. See [field limits](#shared-form-rules) for the complete restrictions.

<a id="before-sending"></a>

## Choose the destination and check access

Run commands in the destination server text/announcement channel or active supported thread, including an accessible private thread or forum post. You need Manage Messages; another administrator with that permission can edit your managed message too.

For creation, WEFT needs current view/send permissions, Send Messages in Threads for a thread, and Embed Links for an authored embed. Archived threads are rejected. WEFT does not unarchive a target or join a private thread to make sending possible.

**Read both the command response and the actual post before repeating a send.** A message can exist even when saving its management record is unconfirmed.

<a id="send-text-or-an-embed"></a>

## Create a message and keep its ID

1. In the intended destination, run [`/message send`](Commands-Message#message-send) with no options. It opens a Modal (an input form); opening it sends nothing. There is no destination option: the command uses the channel where you run it.
2. Enter Message content, embed fields, or both, using an example above. For a text-only announcement, enter `Meeting at 09:30` in Message content and leave all embed fields blank. For a card-only post, leave Message content blank and enter a visible embed title, description or image.
3. Submit the form, then read WEFT’s response and inspect the actual post in the destination channel.
4. On confirmed success, retain the returned **Discord message ID**, or copy the post’s link, for editing. This identifies the sent message, not a schedule reservation.

Whitespace-only content is normalized to empty and is valid with a visible embed. A color-only embed is invalid **even if text is present**. User/role mentions do not notify through automatic parsing. Ordinary URLs are allowed.

<a id="check-the-send-result"></a>

### Check the result before sending again

A confirmed success establishes the Discord send and WEFT management record. The post should contain the text and supported embed you submitted. A post authored by WEFT alone does not prove that registration succeeded.

- If input is rejected as invalid, open a new form with `/message send` and correct the identified field using [the input rules](#shared-form-rules).
- If Discord explicitly rejected the send, the message was not sent. Review the current destination and permissions before deciding whether to retry.
- If sending or management registration is unconfirmed, or removal was rejected/unconfirmed, do not submit another send or delete the post based on an assumed failure. Inspect the actual message and ask the host operator to compare its management record and audit history using the [available checks](Troubleshooting#available-checks). Follow [uncertain outcomes](#permissions-and-uncertain-outcomes).

<a id="edit-an-existing-managed-message"></a>

## Edit and verify an existing message

Use the **same server and channel** as the original post. You need Manage Messages there. WEFT needs View Channel, Read Message History, WEFT authorship and current editability. An actual edit leaving an authored embed also requires Embed Links; sending permission is not required for editing. An archived thread is not a valid edit target.

1. Select [`/message edit`](Commands-Message#message-edit). In `message`, enter the retained Discord message ID or exact `https://discord.com/channels/<server-id>/<channel-id>/<message-id>` link for this channel, then run it. The message must have a confirmed WEFT management record.
2. Review the prefilled saved content/embed fields. For example, change `Meeting at 09:30` to `Meeting at 10:00` in Message content, then submit the form. Opening the form alone makes no change.
3. Read the response and inspect the actual updated post. A confirmed change increases its saved version number (**revision**) once. Coherent identical content returns unchanged, which is a normal result.

Clearing text is allowed only when a visible embed remains. Clearing all embed fields removes the embed when text remains; clearing all visible content is rejected.

If the form is stale, open a fresh form and review the current saved content. A Discord/saved-content mismatch requires inspection; WEFT does not silently repair either side. If editing, saving/confirming its result, or restoration remains unconfirmed, inspect the post and record before another change. `PARTIAL` does not establish which content currently remains. See [edit conflicts](#edit-conflicts-and-mismatches) and [uncertain outcomes](#permissions-and-uncertain-outcomes).

<a id="deletion-and-scheduling"></a>

## Delete a message or schedule a new post

WEFT has no managed-message delete command. Use Discord’s message deletion where authorized. WEFT detects confirmed absence when processing an edit form submission and records `DELETED`; it does not continuously monitor deletion. Deletion detection preserves the saved payload and revision.

To post later, follow [Scheduled messages](Scheduled-Messages). Creating a reservation does not send immediately, and cancelling a reservation does not delete messages already sent.

<a id="shared-form-rules"></a>

## Payload fields and input limits

These rules apply to send, edit, schedule creation and scheduled payload editing.

| Field                                               | Limit / format           | Validation and input notes                                                   |
| --------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| <!-- fact:payload-content --> Plain content         | 2000 Unicode code points | Length is checked before whitespace normalization.                           |
| <!-- fact:payload-title --> Embed title             | 256 UTF-16 code units    | Outer whitespace is trimmed; whitespace-only fields are absent.              |
| <!-- fact:payload-description --> Embed description | 4000 UTF-16 code units   | Outer whitespace is trimmed; whitespace-only fields are absent.              |
| Color                                               | 6 hexadecimal digits     | The leading `#` is optional. Both `FF0000` and `#ff0000` work.               |
| <!-- fact:payload-image --> Image URL               | 2048 code units maximum  | Use an absolute HTTP/HTTPS URL. Both raw and normalized lengths are checked. |

- Plain content length is checked before whitespace normalization. Nonblank content keeps leading/trailing spaces and newlines.
- Embed title and description are outer-trimmed; blank fields are absent. Internal whitespace is kept. Many emoji use two UTF-16 units. Discord’s form can impose its own input limit before submission.
- Editing prefills color as uppercase `#RRGGBB`. Color must have exactly six hexadecimal digits, with optional `#`.
- Image URLs are outer-trimmed and syntax-normalized. WEFT does not download or verify the image.
- One authored rich embed supports only title, description, color and image URL. Attachments, multiple embeds, raw JSON, fields, author, footer, thumbnail, title links and embed timestamps are unsupported.
- Ordinary URLs can produce separate Discord-generated previews. WEFT does not impersonate users through webhook names or avatars.

<a id="edit-conflicts-and-mismatches"></a>

## Understand edit conflicts and mismatches

A **revision** identifies the saved version. Another successful edit makes an older form stale: open a fresh form rather than overwriting newer work. WEFT compares the current complete Discord payload with its saved record even for an unchanged submission. That check still requires current permissions, existence, WEFT authorship and editability. A mismatch stops editing for inspection and does not silently repair either side.

A changed text or supported embed increments the single revision once. Any currently authorized administrator can edit a managed message; the original creator does not have exclusive editing rights. For symptoms and next checks, use [message-edit troubleshooting](Troubleshooting#an-edit-is-stale-unchanged-or-mismatched).

<a id="permissions-and-uncertain-outcomes"></a>

## Unconfirmed changes and attempts to undo them

Before registering a sent message, WEFT verifies the returned server/channel/bot identity and complete supported text/embed payload. If identity is confirmed but payload verification fails before persistence, it may delete that known message once. An unverified identity does not authorize deletion. This is separate from deletion after a proven unsuccessful database save.

Discord can accept a send or edit before WEFT finishes saving its record. A database problem therefore does not by itself mean that the post was never sent or changed. WEFT cannot automatically undo both systems together; use the response to distinguish these cases:

| Reported fact                               | Meaning and safe action                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Send result unconfirmed                     | Sending may already have occurred. Check the destination and operator evidence before another send.                                         |
| Sent; management registration `UNCONFIRMED` | Saving may have succeeded. WEFT does not attempt removal when commit is possible. Inspect the post and record before resending or deleting. |
| Removal confirmed                           | WEFT confirmed deleting the known sent message after a failed payload check or a proven unsuccessful save.                                  |
| Already absent                              | Absence was confirmed at observation; this does not prove WEFT deleted it.                                                                  |
| Removal/restoration rejected                | The attempted undo was rejected; inspect current state.                                                                                     |
| Removal/restoration unconfirmed             | The undo result is unknown; do not assume deletion or restoration.                                                                          |

If saving a change fails, WEFT may try to undo a confirmed Discord effect when safe: deleting a known sent message or restoring previous content. It does not undo a change merely because the database result is unknown. `PARTIAL` records only established historical effects; it does not prove what content or message currently remains.

For investigation, use [result states](Troubleshooting#result-states) and [Audit and privacy](Audit-and-Privacy). Exact command contracts: [`send`](Commands-Message#message-send), [`edit`](Commands-Message#message-edit).

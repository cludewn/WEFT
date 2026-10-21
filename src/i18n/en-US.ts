export const enUS = {
  "command.config.description": "View or change WEFT settings",
  "command.linkPreview.description": "Configure link previews",
  "command.linkPreview.show.description": "Show the link preview mode",
  "command.linkPreview.mode.description": "Set the link preview mode",
  "command.linkPreview.value.description": "How to display link previews",
  "linkPreview.mode.hybrid": "Automatic previews + buttons",
  "linkPreview.mode.public-only": "Automatic public previews only",
  "linkPreview.mode.button-only": "Preview buttons only",
  "linkPreview.mode.off": "Off",
  "linkPreview.show": ({ mode }: { mode: string }) => `Link preview mode: ${mode}`,
  "linkPreview.loadFailed": "Could not load the preview configuration.",
  "command.config.show.description": "Show WEFT settings",
  "command.config.timezone.description": "Set WEFT's default timezone",
  "command.config.timezone.value.description": "IANA timezone, e.g. Asia/Tokyo or UTC",
  "command.config.closed-prefix.description": "Configure the closed prefix",
  "command.config.closed-prefix.set.description": "Set the prefix for future closes",
  "command.config.closed-prefix.set.value.description": "Closed prefix, 1–20 characters",
  "command.config.closed-prefix.disable.description": "Disable the closed prefix",
  "command.config.audit-log.description": "Configure audit notifications",
  "command.config.audit-log.show.description": "Show the audit notification channel",
  "command.config.audit-log.set.description": "Set the audit notification channel",
  "command.config.audit-log.set.channel.description": "Text or announcement channel",
  "command.config.audit-log.disable.description": "Disable audit notifications",
  "command.config.auto-close.description": "Configure automatic thread closing",
  "command.config.auto-close.show.description": "Show automatic-close settings",
  "command.config.auto-close.inactivity.description":
    "Set the inactivity period for automatic closing",
  "command.config.auto-close.inactivity.value.description":
    "5 minutes to 365 days; e.g. 30m, 12h, 7d",
  "command.config.auto-close.bot-messages.description":
    "Choose whether bot posts count as activity",
  "command.config.auto-close.bot-messages.value.description": "Include bot posts",
  "command.config.auto-close.add-parent.description":
    "Enable automatic closing in a parent channel",
  "command.config.auto-close.add-parent.channel.description":
    "Text, announcement, or forum channel",
  "command.config.auto-close.remove-parent.description":
    "Disable automatic closing in a parent channel",
  "command.config.auto-close.remove-parent.channel.description": "Configured parent channel",
  "command.thread.description": "Manage threads",
  "command.thread.bulk-close.description": "Select threads for bulk close",
  "command.thread.close.description": "Close this thread",
  "command.thread.open.description": "Remove the closed prefix from an active thread",
  "command.thread.close-after.description": "Schedule this thread to close after a delay",
  "command.thread.close-after.after.description":
    "Time until closing: 1 minute to 365 days; e.g. 30m, 2h, 7d",
  "command.thread.cancel-close.description": "Cancel this thread's scheduled close",
  "command.thread.track.description": "Remove this thread's automatic-close exclusion",
  "command.thread.untrack.description": "Exclude this thread from automatic close",
  "command.thread.status.description": "Show automatic-close and scheduled-close status",
  "command.message.description": "Send, edit or schedule messages",
  "command.message.send.description": "Send a managed message",
  "command.message.edit.description": "Edit a managed message",
  "command.message.edit.message.description": "Message ID or message link",
  "command.message.schedule.description": "Manage scheduled posts",
  "command.message.schedule.create.description": "Schedule a one-time post",
  "command.message.schedule.create.after.description":
    "Time until sending, e.g. 30m, 2h, 7d (specify either after or at)",
  "command.message.schedule.create.at.description":
    "YYYY-MM-DD HH:mm in WEFT's default timezone (specify either after or at)",
  "command.message.schedule.recurring-create.description": "Set up recurring posts",
  "command.message.schedule.recurring-create.frequency.description": "daily or weekly",
  "command.message.schedule.recurring-create.time.description": "24-hour time as HH:MM, e.g. 09:30",
  "command.message.schedule.recurring-create.weekdays.description":
    "Comma-separated weekdays, e.g. mon,wed,fri; omit for frequency=daily",
  "command.message.schedule.recurring-create.timezone.description":
    "IANA timezone, e.g. Asia/Tokyo or UTC; defaults to WEFT's setting",
  "command.message.schedule.cancel.description": "Cancel a scheduled post",
  "command.message.schedule.cancel.id.description": "Schedule ID",
  "command.message.schedule.status.description": "Show a scheduled post's status",
  "command.message.schedule.status.id.description": "Schedule ID",
  "command.message.schedule.list.description": "List scheduled posts",
  "command.message.schedule.edit.description": "Edit scheduled post content",
  "command.message.schedule.edit.id.description": "Schedule ID",
  "command.message.schedule.reschedule.description": "Change a one-time post's send time",
  "command.message.schedule.reschedule.id.description": "Schedule ID",
  "command.message.schedule.reschedule.after.description":
    "Time until sending, e.g. 30m, 2h, 7d (specify either after or at)",
  "command.message.schedule.reschedule.at.description":
    "YYYY-MM-DD HH:mm in WEFT's default timezone (specify either after or at)",
  "command.message.schedule.recurrence-edit.description":
    "Change a recurring post's repeat settings",
  "command.message.schedule.recurrence-edit.id.description": "Schedule ID",
  "command.message.schedule.recurrence-edit.frequency.description": "daily or weekly",
  "command.message.schedule.recurrence-edit.time.description": "24-hour time as HH:MM, e.g. 09:30",
  "command.message.schedule.recurrence-edit.weekdays.description":
    "Comma-separated weekdays, e.g. mon,wed,fri; omit for frequency=daily",
  "command.message.schedule.recurrence-edit.timezone.description":
    "IANA timezone, e.g. Asia/Tokyo or UTC; omit to keep this schedule's timezone",
  "command.choice.daily": "daily",
  "command.choice.weekly": "weekly",
  "config.invalidTimezone": "Enter an IANA timezone, e.g. Asia/Tokyo or UTC.",
  "config.invalidPrefix":
    "The closed prefix must be 1 to 20 characters with no control characters.",
  "context.guild": "This command can only be used in a server.",
  "permission.manageGuild": "You need the Manage Server permission to use this command.",
  "config.previewInvalid": "Choose a link preview mode from the available choices.",
  "config.previewUnconfirmed":
    "Could not confirm the preview mode change. Check the setting before trying again.",
  "config.previewChanged": ({ mode, unchanged }: { mode: string; unchanged: boolean }) =>
    `Link preview mode: ${mode}${unchanged ? " (unchanged)" : ""}`,
  "config.readFailed": "Could not load the configuration. Try again later.",
  "config.disabled": "Disabled",
  "config.unknown": "Unknown",
  "config.show": ({
    timezone,
    prefix,
    audit,
    automaticClose,
    mode,
  }: {
    timezone: string;
    prefix: string;
    audit: string;
    automaticClose: string;
    mode: string;
  }) =>
    `WEFT default timezone: ${timezone}\nClosed prefix: ${prefix}\n${audit}\n${automaticClose}\nLink preview mode: ${mode}`,
  "config.prefixDisabledAlready": "The closed prefix is already disabled.",
  "config.prefixDisabled": "Closed prefix disabled. Existing thread names are unchanged.",
  "config.valueChanged": ({
    timezone,
    value,
    unchanged,
  }: {
    timezone: boolean;
    value: string;
    unchanged: boolean;
  }) =>
    `${timezone ? "WEFT default timezone" : "Closed prefix"}: ${value}${unchanged ? " (unchanged)" : " (saved)"}`,
  "config.changeUnconfirmed":
    "Could not confirm the configuration change. Check the setting before trying again.",
  "config.autoReadFailed": "Could not load the automatic close configuration. Try again later.",
  "config.invalidInactivity": "Enter 5 minutes to 365 days, e.g. 30m, 12h, 7d.",
  "config.invalidParent": "Choose a text, announcement or forum channel.",
  "config.enablingParent": "Enabling automatic close for this channel...",
  "config.enumerationFailed":
    "Could not read active threads. Automatic close was not enabled. Try again later.",
  "config.noParents": "Automatic-close channels: none",
  "config.exclusionsApply": "Individual thread exclusions take priority.",
  "config.autoDisabled": ({ inactivity }: { inactivity: string }) =>
    `Automatic close: disabled\nInactivity period: ${inactivity}`,
  "config.autoSummary": ({
    inactivity,
    count,
    botMessages,
  }: {
    inactivity: string;
    count: number;
    botMessages: boolean;
  }) =>
    `Automatic close: ${count} ${count === 1 ? "channel" : "channels"}, inactivity ${inactivity}, bot posts ${botMessages ? "included" : "excluded"}`,
  "config.autoThreshold": ({ inactivity }: { inactivity: string }) =>
    `Inactivity period: ${inactivity}`,
  "config.botActivity": ({ enabled }: { enabled: boolean }) =>
    `Bot posts: ${enabled ? "included" : "excluded"}`,
  "config.parents": ({
    count,
    mentions,
    remaining,
  }: {
    count: number;
    mentions: string;
    remaining: number;
  }) => `Channels (${count}): ${mentions}${remaining > 0 ? ` … ${remaining} more` : ""}`,
  "config.inactivityChanged": ({
    inactivity,
    unchanged,
  }: {
    inactivity: string;
    unchanged: boolean;
  }) => `Inactivity period: ${inactivity}${unchanged ? " (unchanged)" : " (saved)"}`,
  "config.botActivityChanged": ({ enabled, unchanged }: { enabled: boolean; unchanged: boolean }) =>
    `Bot posts: ${enabled ? "included" : "excluded"}${unchanged ? " (unchanged)" : " (saved)"}`,
  "config.parentRemoved": ({ channelId, unchanged }: { channelId: string; unchanged: boolean }) =>
    `Automatic close disabled for <#${channelId}>${unchanged ? " (unchanged)" : ""}.`,
  "config.parentAlreadyEnabled": ({ channelId }: { channelId: string }) =>
    `Automatic close is already enabled for <#${channelId}>.`,
  "config.parentEnabled": ({ channelId, count }: { channelId: string; count: number }) =>
    `Automatic close enabled for <#${channelId}>. ${count === 0 ? "No new activity baselines were needed." : `${count} ${count === 1 ? "thread" : "threads"} will count inactivity from now.`}`,
  "config.auditDestination": ({ channelId }: { channelId: string | null }) =>
    `Audit notifications: ${channelId === null ? "disabled" : `<#${channelId}>`}`,
  "config.auditReadFailed": "Could not load audit notification settings. Try again later.",
  "config.auditInvalid":
    "Choose a text or announcement channel where WEFT can View Channel and Send Messages.",
  "config.auditUnconfirmed":
    "Could not confirm the audit notification change. Check the setting before retrying.",
  "config.auditDisabled": "Audit notifications disabled. Database auditing continues.",
  "config.auditAlreadyDisabled":
    "Audit notifications are already disabled. Database auditing continues.",
  "config.auditChanged": ({ channelId, unchanged }: { channelId: string; unchanged: boolean }) =>
    `Audit notification channel: <#${channelId}>${unchanged ? " (unchanged)" : " (saved)"}`,
  "thread.unconfirmed":
    "Could not confirm the final outcome. Check the current thread state before retrying.",
  "thread.actorPermission": "You need the Manage Threads permission to use this command.",
  "thread.botPermission": "WEFT cannot manage this thread with its current permissions.",
  "thread.activeContext": "Use this command in an active thread.",
  "thread.locked": "A locked thread cannot be closed. Unlock it manually before retrying.",
  "thread.invalidName": "The applied closed prefix cannot form a valid thread name.",
  "thread.failed":
    "Could not complete this thread operation. Check the current thread state before retrying.",
  "thread.context": "This command can only be used in a supported thread.",
  "thread.closing": "Closing thread…",
  "thread.opening": "Updating WEFT's state for this active thread…",
  "thread.scheduling": "Scheduling thread close…",
  "thread.cancelling": "Cancelling scheduled thread close…",
  "thread.tracking": "Removing automatic-close exclusion…",
  "thread.untracking": "Excluding thread from automatic close…",
  "thread.loadingStatus": "Loading thread status…",
  "thread.manualExecuting": "A scheduled close is already running. No manual close was started.",
  "thread.manualCancellationUnknown":
    "Scheduled-close cancellation is unconfirmed. No new thread update was started. Check thread status before retrying.",
  "thread.closed": "Thread closed.",
  "thread.alreadyClosed": "Thread is already closed.",
  "thread.pending":
    "WEFT is still processing or confirming this operation. Discord rate limits may delay completion by several minutes.",
  "thread.opened": "Updated WEFT's state for this active thread.",
  "thread.alreadyOpen": "This thread is active. No changes were needed.",
  "thread.excluded": "Thread excluded from automatic close.",
  "thread.alreadyExcluded": "This thread is already excluded from automatic close.",
  "thread.trackedEnabled": "Exclusion removed. This thread is eligible for automatic close.",
  "thread.trackedDisabled":
    "Exclusion removed. Automatic close is still disabled for the parent channel.",
  "thread.alreadyTrackedEnabled":
    "No exclusion was set. This thread is eligible for automatic close.",
  "thread.alreadyTrackedDisabled":
    "No exclusion was set. Automatic close is disabled for the parent channel.",
  "thread.verifyFailed":
    "Could not verify the current thread or your permissions. Try again later.",
  "thread.trackingUnknown":
    "Could not confirm the tracking change. Check the thread status before trying again.",
  "thread.statusFailed": "Could not load this thread's status. Try again later.",
  "thread.trackingFailed": "Could not update the automatic-close exclusion. Try again later.",
  "thread.notRecorded": "not recorded",
  "thread.none": "none",
  "thread.executing": "executing",
  "thread.baselineWarning":
    "The recorded time may be a baseline. Automatic closing runs on periodic checks.",
  "thread.noSchedule": "No thread close is scheduled.",
  "thread.cannotCancel": "The scheduled close is running and cannot be cancelled.",
  "thread.cancelUnknown":
    "Thread-close cancellation is unconfirmed. Check thread status before retrying.",
  "thread.invalidDuration": "Enter 1 minute to 365 days, e.g. 30m, 2h, 7d.",
  "thread.scheduleActiveOnly": "Only active threads can have a scheduled close.",
  "thread.scheduleLocked": "Unlock this thread before scheduling a close.",
  "thread.scheduleExecuting": "A scheduled close is running. Try again after it finishes.",
  "thread.scheduleVerifyFailed": "Could not verify the current thread state. Try again later.",
  "thread.scheduleUnknown":
    "Could not confirm the close schedule was saved. Check thread status before retrying.",
  "thread.status.effective": ({ enabled }: { enabled: boolean }) =>
    `Automatic close: ${enabled ? "eligible" : "not eligible"}`,
  "thread.status.parentPolicy": ({ enabled }: { enabled: boolean }) =>
    `Parent channel: ${enabled ? "enabled" : "disabled"}`,
  "thread.status.exclusion": ({ enabled }: { enabled: boolean }) =>
    `Thread exclusion: ${enabled ? "set" : "not set"}`,
  "thread.status.inactivity": ({ inactivity }: { inactivity: string }) =>
    `Inactivity period: ${inactivity}`,
  "thread.status.activity": ({ when }: { when: string }) => `Last post or baseline: ${when}`,
  "thread.status.scheduledClose": ({ when }: { when: string }) => `Scheduled close: ${when}`,
  "thread.schedule.cancelled": ({ id }: { id: string }) =>
    `Thread close schedule \`${id}\` cancelled.`,
  "thread.schedule.created": ({ id, when }: { id: string; when: string }) =>
    `Thread close scheduled for ${when}. ID: \`${id}\`.`,
  "thread.schedule.replaced": ({ id, when }: { id: string; when: string }) =>
    `Thread close rescheduled for ${when}. ID: \`${id}\`.`,
  "thread.schedule.savedPending": ({ id, when }: { id: string; when: string }) =>
    `Thread close schedule \`${id}\` saved for ${when}. Execution setup is unconfirmed; WEFT will check and repair it automatically.`,
  "message.scheduleCreated": ({
    id,
    channelId,
    when,
    pending,
  }: {
    id: string;
    channelId: string;
    when: number;
    pending: boolean;
  }) =>
    `One-time schedule \`${id}\` saved. Channel: <#${channelId}>. Send time: <t:${when}:F> (<t:${when}:R>).${pending ? " Execution setup is unconfirmed; WEFT will check and repair it automatically." : ""}`,
  "message.scheduleCancelled": ({
    id,
    recurring,
    already,
    cleanupPending,
  }: {
    id: string;
    recurring: boolean;
    already: boolean;
    cleanupPending: boolean;
  }) =>
    `${recurring ? "Recurring schedule" : "One-time schedule"} \`${id}\` ${already ? "was already cancelled" : "cancelled"}.${recurring ? " No future occurrences will be scheduled. Work already running may still finish." : ""}${cleanupPending ? " Stopping queued work is unconfirmed; WEFT will check it automatically." : ""}`,
  "message.recurringCreated": ({
    id,
    when,
    pending,
  }: {
    id: string;
    when: number;
    pending: boolean;
  }) =>
    `Recurring schedule \`${id}\` saved. First send: <t:${when}:F>.${pending ? " Execution setup is unconfirmed; WEFT will check and repair it automatically." : ""}`,
  "message.recurrenceEdited": ({
    id,
    deferred,
    pending,
  }: {
    id: string;
    deferred: boolean;
    pending: boolean;
  }) =>
    `Recurring schedule \`${id}\` updated.${deferred ? " Running or retrying occurrences keep the old settings. The next occurrence will be prepared after they finish." : ""}${pending ? " Execution setup is unconfirmed; WEFT will check and repair it automatically." : ""}`,
  "message.recurrenceUnchanged": ({ id }: { id: string }) =>
    `Recurring schedule \`${id}\` is unchanged.`,
  "message.schedulePayloadEdited": ({
    id,
    recurring,
    unchanged,
  }: {
    id: string;
    recurring: boolean;
    unchanged: boolean;
  }) =>
    `${recurring ? "Recurring schedule" : "One-time schedule"} \`${id}\` content ${unchanged ? "unchanged" : "updated"}.${recurring ? " Running or retrying occurrences keep their previous content." : ""}`,
  "message.rescheduled": ({ id, when, pending }: { id: string; when: number; pending: boolean }) =>
    `One-time schedule \`${id}\` moved to <t:${when}:F> (<t:${when}:R>).${pending ? " Execution setup is unconfirmed; WEFT will check and repair it automatically." : ""}`,
  "message.sent": ({ id }: { id: string }) => `Managed message \`${id}\` sent.`,
  "message.managementUnconfirmed": ({ id }: { id: string }) =>
    `Message \`${id}\` was sent, but WEFT registration is unconfirmed. No deletion was attempted. Check its state before retrying or deleting it.`,
  "message.removalRejected": ({ id }: { id: string }) =>
    `Message \`${id}\` was sent, but WEFT could not finish checking and recording it. Discord rejected the deletion. Inspect it before taking further action; manual deletion may be needed.`,
  "message.removalUnconfirmed": ({ id }: { id: string }) =>
    `Message \`${id}\` was sent, but WEFT could not finish checking and recording it. Its deletion is unconfirmed. It may still exist; check before retrying or deleting it.`,
  "message.edited": ({ id }: { id: string }) => `Managed message \`${id}\` updated.`,
  "message.unchanged": ({ id }: { id: string }) => `Managed message \`${id}\` is unchanged.`,
  "message.deletionUnconfirmed": ({ id }: { id: string }) =>
    `Message \`${id}\` was missing, but WEFT could not confirm its deletion record. Ask an administrator to check.`,
  "message.editPartial": ({ id }: { id: string }) =>
    `Message \`${id}\` was edited, but neither its WEFT record nor a safe restoration is confirmed. Ask an administrator to check the message and record.`,
  "message.contentLabel": "Message content",
  "message.contentDescription": "Enter text or an embed title, description or image URL.",
  "message.embedTitleLabel": "Embed title",
  "message.embedDescriptionLabel": "Embed description",
  "message.embedColorLabel": "Color code",
  "message.embedColorDescription": "e.g. #FF0000 or FF0000",
  "message.embedImageLabel": "Embed image URL",
  "message.embedImageDescription": "Image URL starting with http:// or https://.",
  "message.sendModalTitle": "Send a managed message",
  "message.editModalTitle": "Edit a managed message",
  "message.scheduleModalTitle": "Schedule a post",
  "message.recurringModalTitle": "Set up recurring posts",
  "message.scheduleEditModalTitle": "Edit scheduled post",
  "message.formFailed": "Could not open the message form. Try again later.",
  "message.scheduleContext": "Use a server text or announcement channel, or a thread.",
  "message.context": "Use a server text or announcement channel, or an active thread.",
  "message.managePermission": "The Manage Messages permission is required.",
  "message.timezoneTooLong": "The recurring timezone is too long for this form.",
  "message.scheduleReadFailed": "Could not load the scheduled post. Try again later.",
  "message.referenceScope": "Choose a message in this server and channel.",
  "message.invalidReference": "Enter a message ID or discord.com message link.",
  "message.deletedTarget": "The managed message has been deleted.",
  "message.readFailed": "Could not load the managed message. Try again later.",
  "message.notFound": "No WEFT management record was found for that message in this channel.",
  "message.invalidFrequency": "Set frequency to daily or weekly.",
  "message.invalidTime": "Set time as a 24-hour HH:MM value, e.g. 09:30.",
  "message.invalidWeekdays":
    "frequency=weekly requires one or more unique comma-separated weekdays (mon,tue,wed,thu,fri,sat,sun). Omit weekdays for frequency=daily.",
  "message.invalidTimezone":
    "Set timezone to an IANA timezone, e.g. Asia/Tokyo or UTC. Numeric offsets are not supported.",
  "message.invalidRecurrence": "Check frequency, time (HH:MM), weekdays and timezone.",
  "message.emptyContent": "Enter text or an embed title, description or image URL.",
  "message.contentTooLong": "Message content must be 2000 characters or fewer.",
  "message.embedTitleTooLong": "The embed title must be 256 characters or fewer.",
  "message.embedDescriptionTooLong": "The embed description must be 4000 characters or fewer.",
  "message.invalidEmbedColor": "Enter a 6-digit hexadecimal color code, e.g. #FF0000 or FF0000.",
  "message.embedColorOnly":
    "A color code alone cannot create an embed. Add an embed title, description or image URL.",
  "message.embedImageTooLong": "The embed image URL must be 2048 characters or fewer.",
  "message.invalidEmbedImage": "Enter an image URL starting with http:// or https://.",
  "message.scheduleTarget":
    "Use a text or announcement channel, or an active thread in this server.",
  "message.scheduleArchived": "Messages cannot be scheduled from an archived thread.",
  "message.schedulePermissionLost":
    "You no longer have the Manage Messages permission required to schedule messages.",
  "message.sendBotPermission":
    "WEFT cannot send messages in this channel with its current permissions.",
  "message.channelCheckFailed":
    "Could not verify the current channel or permissions. Try again later.",
  "message.scheduleSaveUnconfirmed":
    "Could not confirm the schedule was saved. WEFT did not register execution. Check the schedule before retrying.",
  "message.cancelExecuting": "The scheduled post is running and cannot be cancelled.",
  "message.scheduleCompleted": "The scheduled post has completed.",
  "message.scheduleFailed": "The scheduled post has failed.",
  "message.scheduleNotFound": "No scheduled post was found in this channel for that ID.",
  "message.cancelUnconfirmed":
    "Could not confirm the cancellation. Inspect the schedule before retrying.",
  "message.scheduleConflict": "The scheduled post changed concurrently. Review it before retrying.",
  "message.guildTimezoneInvalid":
    "WEFT's default timezone is invalid or unavailable. Check it or specify an IANA timezone, e.g. Asia/Tokyo or UTC.",
  "message.recurringSaveUnconfirmed":
    "Could not confirm the recurring schedule was saved. WEFT did not register execution. Check the schedule before retrying.",
  "message.recurringUnavailable": "Recurring scheduling is temporarily unavailable.",
  "message.oneTimeUseReschedule": "This is a one-time schedule; use /message schedule reschedule.",
  "message.recurringConflict":
    "The recurring schedule changed concurrently. Review it before retrying.",
  "message.recurringNotFound": "No recurring schedule was found in this channel for that ID.",
  "message.recurrenceUnconfirmed":
    "Could not confirm the recurrence edit. Inspect the schedule before retrying.",
  "message.recurringReadFailed": "Could not load the recurring schedule. Try again later.",
  "message.timestampNote": "Discord shows timestamps in your local timezone.",
  "message.scheduledFor": "Scheduled for",
  "message.executingScheduledFor": "Current execution scheduled for",
  "message.originalScheduledFor": "Originally scheduled for",
  "message.scheduleCorrupt":
    "WEFT found inconsistent scheduled-post state. Administrator inspection is required.",
  "message.scheduleStatusFailed": "Could not load the scheduled-post status. Try again later.",
  "message.editExecuting": "The scheduled post is running and cannot be edited.",
  "message.scheduleAlreadyCancelled": "The scheduled post was cancelled.",
  "message.scheduleEditConflict":
    "The scheduled post changed after you opened the form. Open a new form and try again.",
  "message.scheduleEditUnconfirmed":
    "Could not confirm the scheduled-post edit. Inspect the current schedule before retrying.",
  "message.unexpectedScheduleEdit":
    "Could not confirm the scheduled content edit result. Check the current schedule before retrying.",
  "message.recurringUseRecurrenceEdit":
    "This is a recurring schedule; use /message schedule recurrence-edit.",
  "message.rescheduleConflict":
    "The scheduled post changed concurrently. Review it and retry the reschedule.",
  "message.rescheduleUnconfirmed":
    "Could not confirm the reschedule. Inspect the current schedule before retrying.",
  "message.rescheduleExecuting": "The scheduled post is running and cannot be rescheduled.",
  "message.unexpectedReschedule":
    "Could not confirm the send-time change result. Check the current schedule before retrying.",
  "message.sendArchived": "Messages cannot be sent in an archived thread.",
  "message.sendPermission": "Sending through WEFT requires the Manage Messages permission.",
  "message.sendRejected": "Discord rejected the message. The message was not sent.",
  "message.sendUnconfirmed":
    "Could not confirm whether Discord sent the message. Check the channel before retrying.",
  "message.alreadyAbsent":
    "The message was sent, but WEFT could not finish checking and recording it. It was absent when checked.",
  "message.sendCompensated":
    "WEFT could not finish checking and recording the sent message, so it was deleted to undo the send.",
  "message.deletionDetected":
    "The Discord message no longer exists and is now marked as deleted in WEFT.",
  "message.editConflict":
    "The message changed after you opened the form. Open a new form and try again.",
  "message.editPermissionLost":
    "You no longer have the Manage Messages permission required to edit this message.",
  "message.stateMismatch":
    "This message does not match WEFT's saved record. An administrator must check it before editing.",
  "message.editArchived": "Messages cannot be edited in an archived thread.",
  "message.invalidEditableTarget":
    "Could not verify that message as editable by WEFT in this channel.",
  "message.editBotPermission":
    "WEFT cannot edit this message with its current access and permissions.",
  "message.messageCheckFailed":
    "Could not verify the current message or permissions. Try again later.",
  "message.editRejected": "Discord rejected the message edit.",
  "message.editNotApplied": "Discord did not apply the message edit. WEFT's record is unchanged.",
  "message.editUnconfirmed":
    "Could not confirm whether Discord applied the edit. Administrator inspection is required.",
  "message.stateCheckFailed": "Could not check WEFT's record. Try again later.",
  "message.editCompensated":
    "Could not confirm WEFT's record of the edit. The previous message content was restored.",
  "message.editFormExpired": "This message edit form is invalid or expired.",
  "message.scheduleFormExpired": "This scheduled-post form is invalid or expired.",
  "message.recurringFormExpired": "This recurring-post form is invalid or expired.",
  "message.scheduleEditFormExpired": "This scheduled-post edit form is invalid or expired.",
  "message.status.creator": ({ id }: { id: string }) => `Creator: <@${id}> (\`${id}\`)`,
  "message.status.weekdays": ({ days }: { days: string }) => `Weekdays: ${days}\n`,
  "message.status.recurring": ({ id }: { id: string }) => `Recurring schedule \`${id}\``,
  "message.status.oneTime": ({ id }: { id: string }) => `One-time schedule \`${id}\``,
  "message.status.series": ({ state }: { state: string }) => `Series status: ${state}`,
  "message.status.state": ({ state }: { state: string }) => `Status: ${state}`,
  "message.status.occurrenceState": ({ state }: { state: string }) => `Occurrence status: ${state}`,
  "message.status.target": ({ id }: { id: string }) => `Target: <#${id}>`,
  "message.status.revision": ({ revision }: { revision: number }) => `Revision: ${revision}`,
  "message.status.recurrence": ({ daily }: { daily: boolean }) =>
    `Recurrence: ${daily ? "Daily" : "Weekly"}`,
  "message.status.localTime": ({ days, time }: { days: string; time: string }) =>
    `${days}Local time: ${time}`,
  "message.status.timezone": ({ timezone }: { timezone: string }) =>
    `Scheduling timezone: ${timezone}`,
  "message.status.occurrence": ({ id }: { id: string | null }) =>
    `Current occurrence: ${id === null ? "none" : `\`${id}\``}`,
  "message.status.occurrenceRetries": ({ count }: { count: number | null }) =>
    `Occurrence retry count: ${count ?? "none"}`,
  "message.status.retries": ({ count }: { count: number }) => `Retry count: ${count}`,
  "message.status.link": ({
    guildId,
    channelId,
    messageId,
  }: {
    guildId: string;
    channelId: string;
    messageId: string;
  }) => `Message: https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
  "message.none": "none",
  "schedule.error.MISSING_SELECTOR": "Specify either after or at.",
  "schedule.error.CONFLICTING_SELECTORS": "Specify either after or at; they cannot be combined.",
  "schedule.error.INVALID_DURATION": "Enter 1m to 365d, e.g. 30m, 2h, 7d.",
  "schedule.error.INVALID_AT_FORMAT": "Use YYYY-MM-DD HH:mm in WEFT's default timezone.",
  "schedule.error.INVALID_AT_DATE": "Enter a valid date.",
  "schedule.error.INVALID_GUILD_TIMEZONE": "Set WEFT's default IANA timezone before using at.",
  "schedule.error.TIMEZONE_UNAVAILABLE": "Could not load WEFT's default timezone. Try again later.",
  "schedule.error.DST_GAP":
    "That time does not exist in the configured timezone. Choose another time.",
  "schedule.error.DST_OVERLAP":
    "That time occurs twice in the configured timezone. Choose another time or use after.",
  "schedule.error.TOO_SOON": "Schedule the message at least one minute ahead.",
  "schedule.error.TOO_FAR": "Choose a time within the next 365 days.",
  "list.unavailable": "Could not load scheduled posts. Try again later.",
  "list.restart": "These list controls are invalid. Run /message schedule list again.",
  "list.display_error": "The complete page could not be displayed safely. No schedules are shown.",
  "list.previous": "Previous",
  "list.next": "Next",
  "list.capacity": "Too many schedule lists are open. Try again later.",
  "list.time.historicalCompact": "Was due",
  "list.time.historical": "Scheduled time before cancellation",
  "list.time.nextCompact": "Next due",
  "list.time.next": "Next occurrence scheduled time",
  "list.time.lastCompact": "Last due",
  "list.time.last": "Most recent occurrence scheduled time",
  "list.time.currentCompact": "Due",
  "list.time.current": "Current occurrence scheduled time",
  "list.invalidPage": "Page must be a positive integer.",
  "list.none": "none",
  "list.empty": ({ page }: { page: number }) => `No active or executing posts on page ${page}.`,
  "list.header": ({ page }: { page: number }) => `Scheduled posts — page ${page}`,
  "list.oneTimeRow": ({
    id,
    state,
    when,
    creator,
  }: {
    id: string;
    state: string;
    when: number;
    creator: string;
  }) => `- \`${id}\` One-time · ${state}\n  Scheduled: <t:${when}:F> · By: ${creator}`,
  "list.recurringRow": ({
    id,
    daily,
    state,
    occurrence,
    label,
    when,
    creator,
  }: {
    id: string;
    daily: boolean;
    state: string;
    occurrence: string;
    label: string;
    when: number;
    creator: string;
  }) =>
    `- \`${id}\` Recurring ${daily ? "daily" : "weekly"}\nSeries: ${state} · Occurrence: ${occurrence}\n${label}: <t:${when}:F> · By ${creator}`,
  "bulk.controlFailure": "This bulk-close action is invalid. Run /thread bulk-close again.",
  "bulk.preparationFailure":
    "Could not prepare the bulk-close preview. Run /thread bulk-close again.",
  "bulk.nameFilter": ({ name }: { name: string }) =>
    `Thread name contains (case-sensitive): ${name}`,
  "bulk.ownerFilter": ({ id }: { id: string }) => `Owner ID: ${id}`,
  "bulk.ageFilter": ({ minutes, cutoff }: { minutes: number; cutoff: number }) =>
    `At least ${minutes} minutes old at preview creation.\nCutoff: <t:${cutoff}:F>`,
  "bulk.candidate": ({ ordinal }: { ordinal: number }) => `Candidate ${ordinal}`,
  "bulk.threadLink": ({
    ordinal,
    name,
    guildId,
    threadId,
  }: {
    ordinal: number;
    name: string;
    guildId: string;
    threadId: string;
  }) => `${ordinal}. ${name} • [Open](https://discord.com/channels/${guildId}/${threadId})`,
  "bulk.unavailableThread": ({ ordinal }: { ordinal: number }) => `${ordinal}. Target unavailable.`,
  "bulk.footer": ({
    page,
    pages,
    candidates,
    selected,
  }: {
    page: number;
    pages: number;
    candidates: number;
    selected: number;
  }) => `Page ${page}/${pages} • Candidates: ${candidates} • Selected: ${selected}`,
  "bulk.selectPlaceholder": "Select threads on this page",
  "bulk.unnamedThread": "Unnamed thread",
  "bulk.targetUnavailable": "Target unavailable",
  "bulk.previous": "Previous",
  "bulk.next": "Next",
  "bulk.clearPage": "Clear page",
  "bulk.confirm": "Close selected threads",
  "bulk.cancel": "Cancel",
  "bulk.selectionGuidance":
    "Select threads, then close them. Selections on other pages are included.",
  "bulk.title": "Bulk thread close",
  "bulk.parent": "Parent",
  "bulk.conditions": "Conditions (AND)",
  "bulk.noFilters": "None. Select threads manually.",
  "bulk.beforeConfirm": "Before closing",
  "bulk.closeWarning": "• Adds the closed prefix if enabled, then archives without locking.",
  "bulk.cancelWarning":
    "• Scheduled closes may be cancelled; cancellation is not reversed if closing fails.",
  "bulk.partialWarning":
    "• Changed state, filters or permissions may cause skips or failures. Results may be partial; some work may finish later.",
  "bulk.snapshotWarning": "• Candidates are fixed; new matching threads are not added.",
  "bulk.expires": "Expires",
  "bulk.setupTitle": "Bulk thread close setup",
  "bulk.owner": "Owner",
  "bulk.nameContains": "Thread name contains",
  "bulk.nameDescription": "Case-sensitive text to match within a thread name",
  "bulk.createdOlder": "Minimum time since creation",
  "bulk.ageDescription": "Minimum age since creation, e.g. 30m, 2h, 7d; not inactivity",
  "bulk.invalidSetup": "Choose one supported parent channel and check the filters.",
  "bulk.preparing": "Preparing bulk-close preview…",
  "bulk.confirmed": "Bulk close started. Results will follow in a separate message.",
  "bulk.cancelled": "Bulk close cancelled.",
  "bulk.cancelledNoWork": "Bulk close cancelled. No target operations were started.",
  "bulk.result": ({
    selected,
    attempted,
    closed,
    alreadyClosed,
    pending,
    failed,
    skipped,
  }: {
    selected: number;
    attempted: number;
    closed: number;
    alreadyClosed: number;
    pending: number;
    failed: number;
    skipped: number;
  }) =>
    `Bulk thread close result\nSelected: ${selected}\nAttempted: ${attempted}\nClosed: ${closed}\nAlready closed: ${alreadyClosed}\nPending: ${pending}\nFailed or unconfirmed: ${failed}\nSkipped: ${skipped}\nWEFT is still handling pending work. Failed or unconfirmed targets may have changed; inspect them before retrying. Skipped targets were not started.`,
  "bulk.invalidFilter": "Enter a creation age from 1 minute to 365 days, e.g. 30m, 2h, 7d.",
  "bulk.unavailable": "Could not verify the selected parent or current management permissions.",
  "bulk.empty": "No eligible active threads match these conditions.",
  "bulk.tooMany": "More than 50 eligible threads match. Narrow the conditions and try again.",
  "bulk.capacity": "Too many bulk-close previews are open. Try again after some expire.",
  "preview.failure": "Could not show this message.",
  "preview.empty": "No supported content is available for this preview.",
  "preview.spoiler": "[spoiler omitted]",
  "preview.button": "Preview",
  "preview.original": "Open original",
  "preview.numberedButton": ({ ordinal }: { ordinal: number }) => `Preview ${ordinal}`,
  "preview.more": ({ count }: { count: number }) => `+${count} more`,
  "preview.userMention": ({ id }: { id: string }) => `@user:${id}`,
  "preview.roleMention": ({ id }: { id: string }) => `@role:${id}`,
  "preview.channelMention": ({ id }: { id: string }) => `#channel:${id}`,
  "audit.label.source": "Source",
  "audit.label.event": "Event",
  "audit.label.outcome": "Outcome",
  "audit.label.actor": "Actor type",
  "audit.label.actorId": "Actor user ID",
  "audit.label.threadId": "Thread ID",
  "audit.label.channelId": "Channel ID",
  "audit.label.messageId": "Message ID",
  "audit.label.scheduleId": "Scheduled action ID",
  "audit.label.occurrenceId": "Occurrence ID",
  "audit.label.failureCode": "Failure code",
  "audit.label.failureStage": "Failure stage",
  "audit.label.discordEvidence": "Discord evidence",
  "audit.label.databaseEffect": "Database changes",
  "audit.label.compensationEvidence": "Undo result",
  "audit.label.skipReason": "Skip reason",
  "audit.label.previousDestination": "Previous destination ID",
  "audit.label.newDestination": "New destination ID",
  "audit.label.previousMode": "Previous mode",
  "audit.label.newMode": "New mode",
  "audit.label.setting": "Setting",
  "audit.label.targetType": "Target type",
  "audit.label.targetId": "Target ID",
  "audit.label.auditId": "Audit ID",
  "audit.title": "WEFT audit",
  "audit.occurredAt": ({ when }: { when: string }) => `Occurred at: \`${when}\``,
  "audit.reason.rename": "WEFT thread name update",
  "audit.reason.close": "WEFT thread close (without locking)",
} as const;

export type MessageKey = keyof typeof enUS;

export type TranslationArguments<K extends MessageKey> = (typeof enUS)[K] extends (
  ...args: infer A
) => string
  ? A
  : [];

export type TranslationCatalog = {
  readonly [K in MessageKey]: (typeof enUS)[K] extends string
    ? string
    : (...args: TranslationArguments<K>) => string;
};

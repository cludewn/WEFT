CREATE INDEX "managed_message_audits_retention_idx" ON "managed_message_audits" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "recurring_message_audits_retention_idx" ON "recurring_message_audits" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "scheduled_message_audits_retention_idx" ON "scheduled_message_audits" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "scheduled_thread_close_audits_retention_idx" ON "scheduled_thread_close_audits" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "thread_audits_retention_idx" ON "thread_audits" USING btree ("created_at","id");
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "template_executions" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_api_key_id_api_key_uuid_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("uuid") ON DELETE no action ON UPDATE no action;
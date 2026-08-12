ALTER TABLE `site_api_endpoints` ADD `consecutive_failure_count` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `site_api_endpoints` ADD `failure_window_started_at` text;
--> statement-breakpoint
ALTER TABLE `site_api_endpoints` ADD `last_failure_scope_id` text;
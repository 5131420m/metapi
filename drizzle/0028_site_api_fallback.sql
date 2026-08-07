ALTER TABLE `sites` ADD `api_endpoint_site_fallback_enabled` integer DEFAULT true;
--> statement-breakpoint
ALTER TABLE `sites` ADD `api_endpoint_site_fallback_cooldown_until` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `api_endpoint_site_fallback_last_selected_at` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `api_endpoint_site_fallback_last_failed_at` text;
--> statement-breakpoint
ALTER TABLE `sites` ADD `api_endpoint_site_fallback_last_failure_reason` text;

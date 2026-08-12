ALTER TABLE `site_api_endpoints` ADD COLUMN `consecutive_failure_count` INT DEFAULT 0;
ALTER TABLE `site_api_endpoints` ADD COLUMN `failure_window_started_at` VARCHAR(191);
ALTER TABLE `site_api_endpoints` ADD COLUMN `last_failure_scope_id` TEXT;

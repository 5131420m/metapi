ALTER TABLE "site_api_endpoints" ADD COLUMN "consecutive_failure_count" INTEGER DEFAULT 0;
ALTER TABLE "site_api_endpoints" ADD COLUMN "failure_window_started_at" TEXT;
ALTER TABLE "site_api_endpoints" ADD COLUMN "last_failure_scope_id" TEXT;

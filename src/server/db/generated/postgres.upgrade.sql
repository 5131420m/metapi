ALTER TABLE "sites" ADD COLUMN "custom_headers_override_request_headers" BOOLEAN DEFAULT true;
ALTER TABLE "sites" ADD COLUMN "max_concurrency" INTEGER NOT NULL DEFAULT 0;

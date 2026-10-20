-- CreateTable
CREATE TABLE "public_endpoints" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "label" TEXT,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 8,
    "status" "ServiceStatus" NOT NULL DEFAULT 'unknown',
    "last_checked_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_latency_ms" DOUBLE PRECISION,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_endpoint_results" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "latency_ms" DOUBLE PRECISION NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "public_endpoint_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_endpoints_service_id_idx" ON "public_endpoints"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_endpoints_service_id_url_key" ON "public_endpoints"("service_id", "url");

-- CreateIndex
CREATE INDEX "public_endpoint_results_endpoint_id_observed_at_idx" ON "public_endpoint_results"("endpoint_id", "observed_at" DESC);

-- AddForeignKey
ALTER TABLE "public_endpoints" ADD CONSTRAINT "public_endpoints_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_endpoint_results" ADD CONSTRAINT "public_endpoint_results_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "public_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;


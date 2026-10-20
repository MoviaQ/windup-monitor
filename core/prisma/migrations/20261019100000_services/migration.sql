-- Services iteration — additive migration (S1 tables untouched).
-- Discovery snapshots, approved loopback checks, immutable results and
-- minimal service incidents. No destructive changes.

-- Additive column: last accepted discovery snapshot timestamp per agent.
ALTER TABLE "agents" ADD COLUMN "last_discovery_at" TIMESTAMPTZ(6);

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('unknown', 'up', 'down', 'paused');

-- CreateTable
CREATE TABLE "discovered_services" (
    "agent_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "transport" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "process_started_at" TIMESTAMPTZ(6),
    "suggested_path" TEXT,
    "suggested_statuses" INTEGER[],
    "available" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "complete_snapshot" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "discovered_services_pkey" PRIMARY KEY ("agent_id","candidate_id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "expected_statuses" INTEGER[],
    "interval_seconds" INTEGER NOT NULL DEFAULT 30,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 5,
    "failure_threshold" INTEGER NOT NULL DEFAULT 3,
    "success_threshold" INTEGER NOT NULL DEFAULT 2,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config_revision" INTEGER NOT NULL DEFAULT 1,
    "horizon_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ServiceStatus" NOT NULL DEFAULT 'unknown',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "consecutive_successes" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_latency_ms" DOUBLE PRECISION,
    "last_error_code" TEXT,
    "up_since" TIMESTAMPTZ(6),
    "process_started_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_results" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "config_revision" INTEGER NOT NULL,
    "agent_seq" BIGINT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "latency_ms" DOUBLE PRECISION NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "service_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_incidents" (
    "id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL,

    CONSTRAINT "service_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovered_services_agent_id_available_idx" ON "discovered_services"("agent_id", "available");

-- CreateIndex
CREATE UNIQUE INDEX "services_check_id_key" ON "services"("check_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_agent_id_candidate_id_key" ON "services"("agent_id", "candidate_id");

-- CreateIndex
CREATE INDEX "services_agent_id_enabled_idx" ON "services"("agent_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "service_results_agent_id_check_id_observed_at_key" ON "service_results"("agent_id", "check_id", "observed_at");

-- CreateIndex
CREATE INDEX "service_results_service_id_observed_at_idx" ON "service_results"("service_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "service_results_agent_id_observed_at_idx" ON "service_results"("agent_id", "observed_at");

-- CreateIndex
CREATE INDEX "service_incidents_service_id_opened_at_idx" ON "service_incidents"("service_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "service_incidents_service_id_resolved_at_idx" ON "service_incidents"("service_id", "resolved_at");

-- AddForeignKey
ALTER TABLE "discovered_services" ADD CONSTRAINT "discovered_services_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_results" ADD CONSTRAINT "service_results_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_results" ADD CONSTRAINT "service_results_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_incidents" ADD CONSTRAINT "service_incidents_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written hardening mirroring the application validation. Prisma cannot
-- express CHECK constraints, so these are appended to the generated SQL.
-- ============================================================================

ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_port_check" CHECK ("port" > 0 AND "port" <= 65535);
ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_kind_check"
  CHECK ("kind" IN ('jellyfin', 't3-code', 'opencode', 'unknown'));
ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_transport_check" CHECK ("transport" IN ('http', 'tcp'));
ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_confidence_check"
  CHECK ("confidence" IN ('high', 'medium', 'low'));
ALTER TABLE "discovered_services"
  ADD CONSTRAINT "discovered_services_suggested_path_check"
  CHECK ("suggested_path" IS NULL OR ("suggested_path" LIKE '/%' AND "suggested_path" NOT LIKE '//%'));

ALTER TABLE "services"
  ADD CONSTRAINT "services_port_check" CHECK ("port" > 0 AND "port" <= 65535);
ALTER TABLE "services"
  ADD CONSTRAINT "services_path_check"
  CHECK ("path" LIKE '/%' AND "path" NOT LIKE '//%' AND length("path") <= 512);
ALTER TABLE "services"
  ADD CONSTRAINT "services_interval_check" CHECK ("interval_seconds" >= 15 AND "interval_seconds" <= 3600);
ALTER TABLE "services"
  ADD CONSTRAINT "services_timeout_check"
  CHECK ("timeout_seconds" >= 1 AND "timeout_seconds" <= 10 AND "timeout_seconds" < "interval_seconds");
ALTER TABLE "services"
  ADD CONSTRAINT "services_threshold_check"
  CHECK ("failure_threshold" >= 1 AND "failure_threshold" <= 100
     AND "success_threshold" >= 1 AND "success_threshold" <= 100);
ALTER TABLE "services"
  ADD CONSTRAINT "services_config_revision_check" CHECK ("config_revision" >= 1);
ALTER TABLE "services"
  ADD CONSTRAINT "services_expected_statuses_check"
  CHECK (cardinality("expected_statuses") >= 1 AND cardinality("expected_statuses") <= 10);
ALTER TABLE "services"
  ADD CONSTRAINT "services_counters_check"
  CHECK ("consecutive_failures" >= 0 AND "consecutive_successes" >= 0);

ALTER TABLE "service_results"
  ADD CONSTRAINT "service_results_status_code_check"
  CHECK ("status_code" IS NULL OR ("status_code" >= 100 AND "status_code" <= 599));
ALTER TABLE "service_results"
  ADD CONSTRAINT "service_results_latency_check" CHECK ("latency_ms" >= 0);
ALTER TABLE "service_results"
  ADD CONSTRAINT "service_results_revision_check" CHECK ("config_revision" >= 1);

-- At most one open incident per service (threshold opens exactly once).
CREATE UNIQUE INDEX "service_incidents_one_open_per_service"
  ON "service_incidents" ("service_id") WHERE "resolved_at" IS NULL;

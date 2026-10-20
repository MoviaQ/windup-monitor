-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('pending', 'online', 'stale', 'offline', 'revoked');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credential_hash" TEXT,
    "credential_hash_next" TEXT,
    "credential_overlap_until" TIMESTAMPTZ(6),
    "rotation_id" TEXT,
    "last_rotation_id" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'pending',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agent_version" TEXT,
    "protocol_version" INTEGER NOT NULL DEFAULT 1,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMPTZ(6),
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "last_snapshot_at" TIMESTAMPTZ(6),
    "notify_on_offline" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enroll_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "enroll_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bootstrap_state" (
    "id" INTEGER NOT NULL,
    "token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootstrap_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_samples" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "cpu_pct" DOUBLE PRECISION NOT NULL,
    "load1" DOUBLE PRECISION,
    "mem_used_b" BIGINT NOT NULL,
    "mem_total_b" BIGINT NOT NULL,
    "uptime_s" BIGINT NOT NULL,
    "net_rx_b" BIGINT NOT NULL,
    "net_tx_b" BIGINT NOT NULL,

    CONSTRAINT "metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disk_samples" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "mount" TEXT NOT NULL,
    "total_b" BIGINT NOT NULL,
    "used_b" BIGINT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disk_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "enroll_tokens_token_hash_key" ON "enroll_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "metric_samples_agent_id_received_at_idx" ON "metric_samples"("agent_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "metric_samples_agent_id_seq_key" ON "metric_samples"("agent_id", "seq");

-- CreateIndex
CREATE INDEX "disk_samples_agent_id_received_at_idx" ON "disk_samples"("agent_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "disk_samples_agent_id_seq_mount_key" ON "disk_samples"("agent_id", "seq", "mount");

-- CreateIndex
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");

-- CreateIndex
CREATE INDEX "audit_log_actor_idx" ON "audit_log"("actor");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disk_samples" ADD CONSTRAINT "disk_samples_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- StatusPilot S1 hardening — hand-written additions to the generated migration.
-- Prisma cannot express CHECK constraints or expression indexes; these mirror
-- docs/data-model.md §1 (single-user, singleton bootstrap, range validation).
-- ============================================================================

-- Single-user: at most one row can ever exist in `users`.
CREATE UNIQUE INDEX "users_singleton_key" ON "users" ((1));

-- Exactly one bootstrap_state row, id = 1.
ALTER TABLE "bootstrap_state"
  ADD CONSTRAINT "bootstrap_state_singleton_check" CHECK ("id" = 1);

-- Enroll token TTL sanity.
ALTER TABLE "enroll_tokens"
  ADD CONSTRAINT "enroll_tokens_expiry_check" CHECK ("expires_at" > "created_at");

-- Metric range validation (also enforced in the application layer).
ALTER TABLE "metric_samples"
  ADD CONSTRAINT "metric_samples_cpu_range_check" CHECK ("cpu_pct" >= 0 AND "cpu_pct" <= 100);
ALTER TABLE "metric_samples"
  ADD CONSTRAINT "metric_samples_mem_check"
  CHECK ("mem_used_b" >= 0 AND "mem_total_b" >= 0 AND "mem_used_b" <= "mem_total_b");
ALTER TABLE "metric_samples"
  ADD CONSTRAINT "metric_samples_counters_check"
  CHECK ("net_rx_b" >= 0 AND "net_tx_b" >= 0 AND "uptime_s" >= 0);

-- Disk sample range validation.
ALTER TABLE "disk_samples"
  ADD CONSTRAINT "disk_samples_range_check"
  CHECK ("total_b" >= 0 AND "used_b" >= 0 AND "used_b" <= "total_b");

-- Append-only host time series: BRIN keeps retention/purge scans cheap.
CREATE INDEX "metric_samples_received_at_brin" ON "metric_samples" USING BRIN ("received_at");

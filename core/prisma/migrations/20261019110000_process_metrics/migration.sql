-- Additive S3: latest bounded per-process CPU/RSS observation per candidate.
CREATE TABLE "service_process_metrics" (
    "agent_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "process_started_at" TIMESTAMPTZ(6) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu_percent" DOUBLE PRECISION,
    "memory_rss_bytes" BIGINT,
    CONSTRAINT "service_process_metrics_pkey" PRIMARY KEY ("agent_id", "candidate_id")
);

CREATE INDEX "service_process_metrics_agent_id_observed_at_idx"
    ON "service_process_metrics"("agent_id", "observed_at" DESC);

ALTER TABLE "service_process_metrics"
    ADD CONSTRAINT "service_process_metrics_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

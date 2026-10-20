-- AI foundations — additive migration (existing tables untouched).
-- Per-user AI settings, AES-GCM encrypted provider credentials and app-side
-- usage events. No inference tables; secrets are never stored in plaintext.
-- See docs/ai-integration-contract.md.

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('openrouter', 'openai', 'chatgpt', 'custom');

-- CreateEnum
CREATE TYPE "AiExecutionMode" AS ENUM ('monitor_only', 'approval_required', 'autonomous');

-- CreateTable
CREATE TABLE "ai_settings" (
    "user_id" TEXT NOT NULL,
    "provider" "AiProvider",
    "model" TEXT,
    "auto_free" BOOLEAN NOT NULL DEFAULT false,
    "execution_mode" "AiExecutionMode" NOT NULL DEFAULT 'approval_required',
    "custom_name" TEXT,
    "base_url" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "ai_credentials" (
    "user_id" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "key_hint" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("user_id","provider")
);

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT,
    "kind" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_events_user_id_occurred_at_idx" ON "ai_usage_events"("user_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

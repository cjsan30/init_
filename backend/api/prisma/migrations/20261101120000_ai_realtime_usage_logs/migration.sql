-- CreateEnum
CREATE TYPE "AiRealtimeUsageType" AS ENUM ('STT_RELAY', 'INTERVIEWER_VOICE', 'INTERVIEWER_PREVIEW');

-- CreateEnum
CREATE TYPE "AiRealtimeUsageSource" AS ENUM ('SERVER_MEASURED', 'CLIENT_REPORTED');

-- CreateTable
CREATE TABLE "ai_realtime_usage_logs" (
    "realtime_usage_log_id" BIGSERIAL NOT NULL,
    "usage_type" "AiRealtimeUsageType" NOT NULL,
    "usage_source" "AiRealtimeUsageSource" NOT NULL,
    "user_id" BIGINT NOT NULL,
    "session_id" BIGINT,
    "report_key" VARCHAR(80),
    "model_name" VARCHAR(120),
    "audio_input_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost_usd" DECIMAL(12,6),
    "cost_metadata_json" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_realtime_usage_logs_pkey" PRIMARY KEY ("realtime_usage_log_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_ai_realtime_usage_logs_report_key" ON "ai_realtime_usage_logs"("report_key");

-- CreateIndex
CREATE INDEX "idx_ai_realtime_usage_logs_user_created" ON "ai_realtime_usage_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_ai_realtime_usage_logs_type_created" ON "ai_realtime_usage_logs"("usage_type", "created_at");

-- CreateIndex
CREATE INDEX "idx_ai_realtime_usage_logs_session" ON "ai_realtime_usage_logs"("session_id");

-- AddForeignKey
ALTER TABLE "ai_realtime_usage_logs" ADD CONSTRAINT "ai_realtime_usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_realtime_usage_logs" ADD CONSTRAINT "ai_realtime_usage_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_sessions"("session_id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "scheduled_deploys" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deployId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_deploys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scheduled_deploys_scheduledFor_idx" ON "scheduled_deploys"("scheduledFor");
CREATE INDEX "scheduled_deploys_status_idx" ON "scheduled_deploys"("status");
ALTER TABLE "scheduled_deploys" ADD CONSTRAINT "scheduled_deploys_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

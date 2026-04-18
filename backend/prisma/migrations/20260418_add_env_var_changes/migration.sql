-- CreateTable
CREATE TABLE "env_var_changes" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "env_var_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "env_var_changes_appId_idx" ON "env_var_changes"("appId");

-- CreateIndex
CREATE INDEX "env_var_changes_appId_key_idx" ON "env_var_changes"("appId", "key");

-- AddForeignKey
ALTER TABLE "env_var_changes" ADD CONSTRAINT "env_var_changes_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Routing pointer for the public Orbit Telegram webhook (Orbit Agents). The webhook path carries
-- only the connection id, and row-level security hides "Entity" rows until the project is known,
-- so the project's current bot connection is recorded here. The pointer holds no secret;
-- orbit_auth can already read every "Project" row. Additive and nullable.
ALTER TABLE "Project" ADD COLUMN "telegramConnectionId" UUID;
CREATE UNIQUE INDEX "Project_telegramConnectionId_key" ON "Project"("telegramConnectionId");

-- Preserve private chat lifecycle and versioned proposal contents on existing installations.
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

CREATE FUNCTION chat_proposal_preserve_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId", NEW."projectId", NEW."userId", NEW."conversationId", NEW."groupId", NEW."version", NEW."payload", NEW."payloadHash", NEW."createdAt")
    IS DISTINCT FROM
     ROW(OLD."workspaceId", OLD."projectId", OLD."userId", OLD."conversationId", OLD."groupId", OLD."version", OLD."payload", OLD."payloadHash", OLD."createdAt") THEN
    RAISE EXCEPTION 'CHAT_PROPOSAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_proposal_preserve_version BEFORE UPDATE ON "ChatProposal"
  FOR EACH ROW EXECUTE FUNCTION chat_proposal_preserve_version();

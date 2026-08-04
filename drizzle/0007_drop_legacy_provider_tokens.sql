DO $$
DECLARE
	unpreserved_credentials boolean;
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'open_review_duck_provider_connection'
			AND column_name = 'encryptedAccessToken'
	) THEN
		EXECUTE '
			SELECT EXISTS (
				SELECT 1
				FROM "open_review_duck_provider_connection" connection
				WHERE connection."encryptedAccessToken" IS NOT NULL
					AND NOT EXISTS (
						SELECT 1
						FROM "open_review_duck_oauth_credential" credential
						WHERE credential."connectionId" = connection."id"
					)
			)'
		INTO unpreserved_credentials;
		IF unpreserved_credentials THEN
			RAISE EXCEPTION 'Legacy provider OAuth credentials were not preserved';
		END IF;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "open_review_duck_provider_connection"
	DROP COLUMN IF EXISTS "encryptedAccessToken",
	DROP COLUMN IF EXISTS "encryptedRefreshToken",
	DROP COLUMN IF EXISTS "expiresAt";

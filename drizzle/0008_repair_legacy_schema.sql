DO $$
DECLARE
	current_order text[];
	expected_order constant text[] := ARRAY[
		'queued',
		'running',
		'waiting_for_provider',
		'streaming',
		'completed',
		'failed',
		'cancelled'
	];
BEGIN
	SELECT array_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder)
	INTO current_order
	FROM pg_type type_info
	INNER JOIN pg_namespace namespace_info
		ON namespace_info.oid = type_info.typnamespace
	INNER JOIN pg_enum enum_value
		ON enum_value.enumtypid = type_info.oid
	WHERE namespace_info.nspname = 'public'
		AND type_info.typname = 'ai_job_status';

	IF current_order IS NULL THEN
		RAISE EXCEPTION 'Required enum public.ai_job_status is missing';
	END IF;
	IF NOT (current_order <@ expected_order AND expected_order <@ current_order) THEN
		RAISE EXCEPTION 'public.ai_job_status has unexpected values: %', current_order;
	END IF;
	IF current_order <> expected_order THEN
		IF to_regtype('public.ai_job_status_legacy') IS NOT NULL THEN
			RAISE EXCEPTION 'Temporary enum public.ai_job_status_legacy already exists';
		END IF;
		EXECUTE 'ALTER TABLE public."open_review_duck_ai_job" ALTER COLUMN status DROP DEFAULT';
		EXECUTE 'ALTER TYPE public.ai_job_status RENAME TO ai_job_status_legacy';
		EXECUTE 'CREATE TYPE public.ai_job_status AS ENUM (
			''queued'',
			''running'',
			''waiting_for_provider'',
			''streaming'',
			''completed'',
			''failed'',
			''cancelled''
		)';
		EXECUTE 'ALTER TABLE public."open_review_duck_ai_job"
			ALTER COLUMN status TYPE public.ai_job_status
			USING status::text::public.ai_job_status';
		EXECUTE 'ALTER TABLE public."open_review_duck_ai_job"
			ALTER COLUMN status SET DEFAULT ''queued''::public.ai_job_status';
		EXECUTE 'DROP TYPE public.ai_job_status_legacy';
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint constraint_info
		INNER JOIN pg_class table_info
			ON table_info.oid = constraint_info.conrelid
		INNER JOIN pg_namespace namespace_info
			ON namespace_info.oid = table_info.relnamespace
		WHERE namespace_info.nspname = 'public'
			AND table_info.relname = 'open_review_duck_ai_job'
			AND constraint_info.conname = 'ai_job_question_context_check'
	) THEN
		ALTER TABLE public."open_review_duck_ai_job"
			ADD CONSTRAINT "ai_job_question_context_check"
			CHECK (
				(
					question IS NULL
					AND "focusLine" IS NULL
					AND "threadId" IS NULL
				)
				OR (
					question IS NOT NULL
					AND "focusLine" IS NOT NULL
					AND "threadId" IS NOT NULL
				)
			) NOT VALID;
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public."open_review_duck_ai_job"
	VALIDATE CONSTRAINT "ai_job_question_context_check";
--> statement-breakpoint
DO $$
DECLARE
	index_columns text[];
	index_is_unique boolean;
BEGIN
	SELECT
		array_agg(attribute_info.attname ORDER BY indexed_column.ordinality),
		bool_and(index_info.indisunique)
	INTO index_columns, index_is_unique
	FROM pg_class table_info
	INNER JOIN pg_namespace namespace_info
		ON namespace_info.oid = table_info.relnamespace
	INNER JOIN pg_index index_info
		ON index_info.indrelid = table_info.oid
	INNER JOIN pg_class index_class
		ON index_class.oid = index_info.indexrelid
	CROSS JOIN LATERAL unnest(index_info.indkey)
		WITH ORDINALITY AS indexed_column(attnum, ordinality)
	INNER JOIN pg_attribute attribute_info
		ON attribute_info.attrelid = table_info.oid
		AND attribute_info.attnum = indexed_column.attnum
	WHERE namespace_info.nspname = 'public'
		AND table_info.relname = 'open_review_duck_repository'
		AND index_class.relname = 'repository_external_idx'
		AND indexed_column.ordinality <= index_info.indnkeyatts;

	IF index_columns IS DISTINCT FROM ARRAY[
		'workspaceId',
		'connectionId',
		'externalId'
	]::text[] OR index_is_unique IS DISTINCT FROM true THEN
		DROP INDEX IF EXISTS public."repository_external_idx";
		CREATE UNIQUE INDEX "repository_external_idx"
			ON public."open_review_duck_repository"
			USING btree ("workspaceId", "connectionId", "externalId");
	END IF;
END $$;

CREATE TABLE safety.classification_events (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  age_band text NOT NULL CHECK (age_band IN ('lower_primary','middle_primary','upper_primary')),
  source text NOT NULL CHECK (source IN ('ai_input', 'ai_output', 'challenge_event')),
  source_reference_id text NOT NULL CHECK (char_length(source_reference_id) BETWEEN 1 AND 200),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  category text NOT NULL CHECK (category IN (
    'abuse_or_neglect', 'dangerous_instruction', 'identifying_information',
    'none', 'self_harm', 'sexual_content', 'unsafe_contact'
  )),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'low', 'medium', 'none')),
  action text NOT NULL CHECK (action IN ('allow', 'block_and_guide', 'escalate')),
  created_at timestamptz NOT NULL
);

ALTER TABLE learning.generated_learning_requests
  DROP CONSTRAINT generated_learning_requests_unavailable_reason_check,
  ADD CONSTRAINT generated_learning_requests_unavailable_reason_check CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN (
      'CAPABILITY_UNAVAILABLE','CONSENT_WITHDRAWN','GENERATION_CANCELED',
      'GENERATION_CHECK_FAILED','MODEL_UNAVAILABLE','SAFETY_BLOCKED',
      'SOURCE_CHANGED','SOURCE_UNAVAILABLE'
    )
  );
ALTER TABLE learning.suggested_assessments
  DROP CONSTRAINT suggested_assessments_unavailable_reason_check,
  ADD CONSTRAINT suggested_assessments_unavailable_reason_check CHECK (
    unavailable_reason IN (
      'CAPABILITY_UNAVAILABLE','CONSENT_WITHDRAWN','LOW_CONFIDENCE',
      'MODEL_UNAVAILABLE','RUBRIC_REQUIRED','SAFETY_BLOCKED','SOURCE_CHANGED'
    )
  );
ALTER TABLE learning.review_card_requests
  DROP CONSTRAINT review_card_requests_unavailable_reason_check,
  ADD CONSTRAINT review_card_requests_unavailable_reason_check CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN (
      'CAPABILITY_CONTAINED','CAPABILITY_UNAVAILABLE','CONSENT_WITHDRAWN',
      'GENERATION_CHECK_FAILED','MODEL_UNAVAILABLE','SAFETY_BLOCKED','SOURCE_CHANGED'
    )
  );

CREATE TABLE safety.cases (
  id uuid PRIMARY KEY,
  classification_id uuid NOT NULL REFERENCES safety.classification_events(id),
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  age_band text NOT NULL CHECK (age_band IN ('lower_primary','middle_primary','upper_primary')),
  source text NOT NULL CHECK (source IN ('ai_input', 'ai_output', 'challenge_event')),
  source_reference_id text NOT NULL CHECK (char_length(source_reference_id) BETWEEN 1 AND 200),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  category text NOT NULL CHECK (category <> 'none'),
  severity text NOT NULL CHECK (severity IN ('critical', 'high')),
  guardian_may_be_involved boolean NOT NULL,
  assigned_operator_id text CHECK(assigned_operator_id IS NULL OR char_length(assigned_operator_id) BETWEEN 1 AND 200),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('closed_false_positive', 'open', 'pending_retry', 'resolved')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE safety.case_notifications (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES safety.cases(id),
  status text NOT NULL CHECK(status IN('acknowledged','pending')),
  created_at timestamptz NOT NULL,
  acknowledged_at timestamptz
);

CREATE TABLE safety.case_queue_access_audit (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL CHECK(char_length(operator_id) BETWEEN 1 AND 200),
  case_ids uuid[] NOT NULL,
  result_count integer NOT NULL CHECK(result_count>=0),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE safety.support_access_grants (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  created_by_guardian_id uuid NOT NULL,
  support_principal_id text NOT NULL CHECK (char_length(support_principal_id) BETWEEN 1 AND 200),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 4
    AND scopes <@ ARRAY['learning_summary','processing_status','specified_record','technical_metadata']::text[]
  ),
  allowed_record_ids text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours'),
  revoked_at timestamptz,
  CONSTRAINT support_grant_profile_fk
    FOREIGN KEY (family_space_id, learning_profile_id)
    REFERENCES learning.learning_profiles(family_space_id, id) ON DELETE CASCADE,
  CONSTRAINT support_grant_guardian_fk
    FOREIGN KEY (created_by_guardian_id) REFERENCES learning.guardians(id)
);

CREATE TABLE safety.support_access_audit (
  id bigserial PRIMARY KEY,
  grant_id uuid NOT NULL,
  support_principal_id text NOT NULL,
  scope text NOT NULL,
  record_id text,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 200),
  allowed boolean NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE safety.case_operation_audit (
  id bigserial PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE,
  case_id uuid NOT NULL,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('claim','escalation_failed','false_positive','release','resolved','retry_started')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  applied boolean NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX safety_cases_status_time_idx ON safety.cases (status, created_at, id);
CREATE INDEX safety_cases_claim_lease_idx ON safety.cases (claim_expires_at, id)
  WHERE status IN ('open','pending_retry');
CREATE INDEX case_notifications_status_time_idx ON safety.case_notifications (status, created_at, id);
CREATE INDEX case_queue_access_operator_time_idx ON safety.case_queue_access_audit (operator_id, occurred_at, id);
CREATE INDEX support_grants_principal_expiry_idx ON safety.support_access_grants (support_principal_id, expires_at, id);
CREATE INDEX support_audit_grant_time_idx ON safety.support_access_audit (grant_id, occurred_at, id);
CREATE INDEX case_operation_audit_case_time_idx ON safety.case_operation_audit (case_id, occurred_at, id);

ALTER TABLE safety.classification_events
  ALTER COLUMN family_space_id DROP NOT NULL,
  ALTER COLUMN learning_profile_id DROP NOT NULL,
  ADD COLUMN subject_token text CHECK (subject_token IS NULL OR subject_token ~ '^[0-9a-f]{64}$'),
  ADD COLUMN protected_context bytea,
  ADD COLUMN protection_key_id text;
ALTER TABLE safety.cases
  ALTER COLUMN family_space_id DROP NOT NULL,
  ALTER COLUMN learning_profile_id DROP NOT NULL,
  ADD COLUMN subject_token text CHECK (subject_token IS NULL OR subject_token ~ '^[0-9a-f]{64}$'),
  ADD COLUMN protected_context bytea,
  ADD COLUMN protection_key_id text;
ALTER TABLE safety.classification_events
  ALTER COLUMN subject_token SET NOT NULL,
  ALTER COLUMN protected_context SET NOT NULL,
  ALTER COLUMN protection_key_id SET NOT NULL,
  ADD CONSTRAINT classification_source_reference_token
    CHECK (source_reference_id ~ '^[0-9a-f]{64}$');
ALTER TABLE safety.cases
  ALTER COLUMN subject_token SET NOT NULL,
  ALTER COLUMN protected_context SET NOT NULL,
  ALTER COLUMN protection_key_id SET NOT NULL,
  ADD CONSTRAINT case_source_reference_token
    CHECK (source_reference_id ~ '^[0-9a-f]{64}$');
ALTER TABLE safety.challenge_reports
  DROP CONSTRAINT challenge_reports_reporter_learning_profile_id_fkey,
  DROP CONSTRAINT challenge_reports_participant_a_learning_profile_id_fkey,
  DROP CONSTRAINT challenge_reports_participant_b_learning_profile_id_fkey,
  ALTER COLUMN challenge_id DROP NOT NULL,
  ALTER COLUMN reporter_learning_profile_id DROP NOT NULL,
  ALTER COLUMN participant_a_learning_profile_id DROP NOT NULL,
  ALTER COLUMN participant_b_learning_profile_id DROP NOT NULL,
  ADD COLUMN subject_tokens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN reporter_subject_token text,
  ADD COLUMN source_reference_token text,
  ADD COLUMN age_band text;

-- A report cannot be irreversibly pseudonymized without first producing its
-- KMS-protected investigation mapping. A pre-launch database is expected to
-- have no reports here; an existing deployment must perform the controlled
-- encryption backfill before this migration is allowed to proceed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM safety.challenge_reports) THEN
    RAISE EXCEPTION 'SAFETY_CHALLENGE_REPORT_MAPPING_BACKFILL_REQUIRED';
  END IF;
END $$;

ALTER TABLE safety.challenge_reports
  ALTER COLUMN subject_tokens DROP DEFAULT,
  ALTER COLUMN reporter_subject_token SET NOT NULL,
  ALTER COLUMN source_reference_token SET NOT NULL,
  ALTER COLUMN age_band SET NOT NULL,
  ADD CONSTRAINT challenge_report_subject_tokens
    CHECK (
      cardinality(subject_tokens) = 2
      AND subject_tokens[1] ~ '^[0-9a-f]{64}$'
      AND subject_tokens[2] ~ '^[0-9a-f]{64}$'
      AND subject_tokens[1] <> subject_tokens[2]
    ),
  ADD CONSTRAINT challenge_report_reporter_subject_token
    CHECK (
      reporter_subject_token ~ '^[0-9a-f]{64}$'
      AND reporter_subject_token = ANY(subject_tokens)
    ),
  ADD CONSTRAINT challenge_report_source_reference_token
    CHECK (source_reference_token ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT challenge_report_age_band
    CHECK (age_band IN ('lower_primary','middle_primary','upper_primary')),
  ADD CONSTRAINT challenge_report_raw_challenge_removed
    CHECK (challenge_id IS NULL);

CREATE TABLE safety.challenge_report_subject_mappings (
  report_id uuid NOT NULL REFERENCES safety.challenge_reports(id) ON DELETE CASCADE,
  subject_token text NOT NULL CHECK (subject_token ~ '^[0-9a-f]{64}$'),
  mapping_role text NOT NULL CHECK (mapping_role IN ('participant','reporter')),
  protected_context bytea NOT NULL CHECK (octet_length(protected_context) > 28),
  protection_key_id text NOT NULL CHECK (char_length(protection_key_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '180 days'
  ),
  PRIMARY KEY (report_id,subject_token)
);
CREATE INDEX challenge_report_subject_mapping_expiry_idx
  ON safety.challenge_report_subject_mappings(expires_at,report_id,subject_token);

CREATE TABLE safety.challenge_report_mapping_access_audit (
  id bigserial PRIMARY KEY,
  report_id uuid NOT NULL,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 2),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX challenge_report_mapping_access_audit_report_time_idx
  ON safety.challenge_report_mapping_access_audit(report_id,occurred_at,id);

CREATE TABLE safety.challenge_report_classification_outbox (
  id uuid PRIMARY KEY,
  subject_token text NOT NULL CHECK (subject_token ~ '^[0-9a-f]{64}$'),
  source_reference_id text NOT NULL UNIQUE CHECK (source_reference_id ~ '^[0-9a-f]{64}$'),
  report_reason text NOT NULL CHECK (
    report_reason IN ('other_preset','suspected_cheating','uncomfortable','unsafe_content')
  ),
  age_band text NOT NULL CHECK (age_band IN ('lower_primary','middle_primary','upper_primary')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('completed','pending','processing')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT '-infinity',
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX challenge_report_classification_outbox_pending_idx
  ON safety.challenge_report_classification_outbox(next_attempt_at,created_at,id)
  WHERE status='pending';

INSERT INTO safety.challenge_report_classification_outbox(
  id,subject_token,source_reference_id,report_reason,age_band,created_at
)
SELECT id,reporter_subject_token,source_reference_token,reason,age_band,created_at
FROM safety.challenge_reports
WHERE status <> 'closed';

CREATE OR REPLACE FUNCTION safety.protect_challenge_report_identifiers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
DECLARE
  v_tokens text[];
  v_reporter_token text;
  v_source_token text;
  v_grade integer;
  v_mappings jsonb;
BEGIN
  BEGIN
    v_tokens := ARRAY(
      SELECT jsonb_array_elements_text(
        current_setting('rhea.safety_subject_tokens',true)::jsonb
      )
    );
    v_reporter_token := current_setting('rhea.safety_reporter_subject_token',true);
    v_source_token := current_setting('rhea.safety_source_reference_token',true);
    v_mappings := current_setting('rhea.safety_subject_mappings',true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SAFETY_SUBJECT_TOKENS_REQUIRED';
  END;
  IF cardinality(v_tokens) <> 2
     OR (SELECT count(DISTINCT token) FROM unnest(v_tokens) token) <> 2
     OR EXISTS (SELECT 1 FROM unnest(v_tokens) token WHERE token !~ '^[0-9a-f]{64}$')
     OR v_reporter_token !~ '^[0-9a-f]{64}$'
     OR NOT (v_reporter_token = ANY(v_tokens))
     OR v_source_token !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_mappings) <> 'array'
     OR jsonb_array_length(v_mappings) <> 2
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_mappings) mapping
       WHERE mapping ->> 'subjectToken' <> ALL(v_tokens)
          OR mapping ->> 'mappingRole' NOT IN ('participant','reporter')
          OR mapping ->> 'protectedContext' IS NULL
          OR char_length(mapping ->> 'protectionKeyId') NOT BETWEEN 1 AND 200
     )
     OR (
       SELECT count(DISTINCT mapping ->> 'subjectToken')
       FROM jsonb_array_elements(v_mappings) mapping
     ) <> 2
     OR (
       SELECT count(*) FROM jsonb_array_elements(v_mappings) mapping
       WHERE mapping ->> 'mappingRole' = 'reporter'
     ) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_mappings) mapping
       WHERE mapping ->> 'subjectToken' = v_reporter_token
         AND mapping ->> 'mappingRole' = 'reporter'
     ) THEN
    RAISE EXCEPTION 'SAFETY_SUBJECT_TOKENS_INVALID';
  END IF;
  SELECT grade INTO v_grade FROM learning.learning_profiles
  WHERE id=NEW.reporter_learning_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAFETY_REPORTER_PROFILE_NOT_FOUND'; END IF;
  NEW.reporter_learning_profile_id := NULL;
  NEW.challenge_id := NULL;
  NEW.participant_a_learning_profile_id := NULL;
  NEW.participant_b_learning_profile_id := NULL;
  NEW.subject_tokens := v_tokens;
  NEW.reporter_subject_token := v_reporter_token;
  NEW.source_reference_token := v_source_token;
  NEW.age_band := CASE
    WHEN v_grade <= 2 THEN 'lower_primary'
    WHEN v_grade <= 4 THEN 'middle_primary'
    ELSE 'upper_primary'
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_reports_protect_identifiers
  BEFORE INSERT ON safety.challenge_reports
  FOR EACH ROW EXECUTE FUNCTION safety.protect_challenge_report_identifiers();

CREATE OR REPLACE FUNCTION safety.store_challenge_report_subject_mappings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
DECLARE v_mappings jsonb;
BEGIN
  v_mappings := current_setting('rhea.safety_subject_mappings',true)::jsonb;
  INSERT INTO safety.challenge_report_subject_mappings(
    report_id,subject_token,mapping_role,protected_context,protection_key_id,
    created_at,expires_at
  )
  SELECT
    NEW.id,
    mapping ->> 'subjectToken',
    mapping ->> 'mappingRole',
    decode(mapping ->> 'protectedContext','base64'),
    mapping ->> 'protectionKeyId',
    NEW.created_at,
    NEW.created_at + interval '180 days'
  FROM jsonb_array_elements(v_mappings) mapping;
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_reports_store_subject_mappings
  AFTER INSERT ON safety.challenge_reports
  FOR EACH ROW EXECUTE FUNCTION safety.store_challenge_report_subject_mappings();

CREATE OR REPLACE FUNCTION safety.queue_challenge_report_classification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
BEGIN
  INSERT INTO safety.challenge_report_classification_outbox(
    id,subject_token,source_reference_id,report_reason,age_band,created_at
  ) VALUES(
    NEW.id,NEW.reporter_subject_token,NEW.source_reference_token,NEW.reason,
    NEW.age_band,NEW.created_at
  );
  RETURN NEW;
END $$;
CREATE TRIGGER challenge_reports_queue_classification
  AFTER INSERT ON safety.challenge_reports
  FOR EACH ROW EXECUTE FUNCTION safety.queue_challenge_report_classification();

CREATE OR REPLACE FUNCTION safety.claim_challenge_report_classifications(p_limit integer)
RETURNS SETOF safety.challenge_report_classification_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM safety.challenge_report_classification_outbox
    WHERE (status='pending' AND next_attempt_at<=now())
      OR (status='processing' AND lease_until<now())
    ORDER BY created_at,id
    LIMIT LEAST(GREATEST(p_limit,1),100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE safety.challenge_report_classification_outbox outbox
  SET status='processing',attempts=attempts+1,lease_until=now()+interval '1 minute'
  FROM candidates WHERE outbox.id=candidates.id
  RETURNING outbox.*;
END $$;

CREATE OR REPLACE FUNCTION safety.fail_challenge_report_classification(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
BEGIN
  UPDATE safety.challenge_report_classification_outbox
  SET status='pending',lease_until=NULL,
      next_attempt_at=now()+LEAST(interval '15 minutes',interval '5 seconds'*power(2,LEAST(attempts,8)))
  WHERE id=p_id AND status='processing';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION safety.record_classification_and_case(
  p_classification jsonb,
  p_case jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, safety
AS $$
BEGIN
  IF p_classification ? 'familySpaceId' AND p_classification ? 'learningProfileId' AND EXISTS (
    SELECT 1 FROM learning.privacy_tasks
    WHERE family_space_id=(p_classification ->> 'familySpaceId')::uuid
      AND learning_profile_id=(p_classification ->> 'learningProfileId')::uuid
      AND kind='erasure'
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO safety.classification_events (
    id, family_space_id, learning_profile_id, subject_token, source,
    source_reference_id, source_hash, category, severity, action, age_band,
    protected_context, protection_key_id, created_at
  ) VALUES (
    (p_classification ->> 'id')::uuid,
    NULL, NULL, p_classification ->> 'subjectToken',
    p_classification ->> 'source', p_classification ->> 'sourceReferenceToken',
    p_classification ->> 'sourceHash', p_classification ->> 'category',
    p_classification ->> 'severity', p_classification ->> 'action',
    p_classification ->> 'ageBand', decode(p_classification ->> 'protectedContext','base64'),
    p_classification ->> 'protectionKeyId',
    (p_classification ->> 'createdAt')::timestamptz
  );
  IF p_case IS NOT NULL AND p_case <> 'null'::jsonb THEN
    INSERT INTO safety.cases (
      id, classification_id, family_space_id, learning_profile_id, subject_token,
      source, source_reference_id, source_hash, category, severity,
      guardian_may_be_involved, age_band, status, retry_count, created_at, updated_at,
      protected_context, protection_key_id
    ) VALUES (
      (p_case ->> 'id')::uuid, (p_case ->> 'classificationId')::uuid,
      NULL, NULL, p_case ->> 'subjectToken',
      p_case ->> 'source', p_case ->> 'sourceReferenceToken', p_case ->> 'sourceHash',
      p_case ->> 'category', p_case ->> 'severity',
      (p_case ->> 'guardianMayBeInvolved')::boolean, p_case ->> 'ageBand',
      p_case ->> 'status', (p_case ->> 'retryCount')::integer,
      (p_case ->> 'createdAt')::timestamptz, (p_case ->> 'updatedAt')::timestamptz,
      decode(p_case ->> 'protectedContext','base64'), p_case ->> 'protectionKeyId'
    );
    INSERT INTO safety.case_notifications(case_id,status,created_at)
    VALUES((p_case ->> 'id')::uuid,'pending',(p_case ->> 'createdAt')::timestamptz);
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION safety.complete_challenge_report_classification(
  p_id uuid,p_classification jsonb,p_case jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,safety AS $$
BEGIN
  PERFORM 1 FROM safety.challenge_report_classification_outbox
  WHERE id=p_id AND status='processing' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT safety.record_classification_and_case(p_classification,p_case) THEN RETURN false; END IF;
  UPDATE safety.challenge_report_classification_outbox
  SET status='completed',lease_until=NULL,completed_at=now()
  WHERE id=p_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION safety.api_create_support_grant(p_grant jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety AS $$
BEGIN
  INSERT INTO safety.support_access_grants (
    id, family_space_id, learning_profile_id, created_by_guardian_id,
    support_principal_id, scopes, allowed_record_ids, reason,
    created_at, expires_at, revoked_at
  ) VALUES (
    (p_grant ->> 'id')::uuid, (p_grant ->> 'familySpaceId')::uuid,
    (p_grant ->> 'learningProfileId')::uuid, (p_grant ->> 'createdByGuardianId')::uuid,
    p_grant ->> 'supportPrincipalId', ARRAY(SELECT jsonb_array_elements_text(p_grant -> 'scopes')),
    ARRAY(SELECT jsonb_array_elements_text(p_grant -> 'allowedRecordIds')),
    p_grant ->> 'reason', (p_grant ->> 'createdAt')::timestamptz,
    (p_grant ->> 'expiresAt')::timestamptz, NULL
  );
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION safety.api_find_support_grant(p_id uuid)
RETURNS SETOF safety.support_access_grants
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, safety AS $$
  SELECT * FROM safety.support_access_grants WHERE id = p_id
$$;

CREATE OR REPLACE FUNCTION safety.api_revoke_support_grant(
  p_id uuid, p_guardian_id uuid, p_family_space_id uuid, p_revoked_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety AS $$
BEGIN
  UPDATE safety.support_access_grants SET revoked_at = p_revoked_at
  WHERE id = p_id AND created_by_guardian_id = p_guardian_id
    AND family_space_id = p_family_space_id AND revoked_at IS NULL;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION safety.api_append_support_audit(p_audit jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety AS $$
BEGIN
  INSERT INTO safety.support_access_audit (
    grant_id, support_principal_id, scope, record_id, action, allowed, occurred_at
  ) VALUES (
    (p_audit ->> 'grantId')::uuid, p_audit ->> 'supportPrincipalId',
    p_audit ->> 'scope', p_audit ->> 'recordId', p_audit ->> 'action',
    (p_audit ->> 'allowed')::boolean, (p_audit ->> 'occurredAt')::timestamptz
  );
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION safety.read_challenge_report_subject_mappings(
  p_report_id uuid,
  p_operator_id text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS TABLE(
  subject_token text,
  mapping_role text,
  protected_context bytea,
  protection_key_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, safety
AS $$
DECLARE v_count integer;
BEGIN
  IF btrim(p_operator_id) = '' OR char_length(p_operator_id) > 200
     OR btrim(p_reason) = '' OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'invalid challenge report mapping access audit';
  END IF;
  SELECT count(*)::integer INTO v_count
  FROM safety.challenge_report_subject_mappings mapping
  WHERE mapping.report_id=p_report_id AND mapping.expires_at>p_occurred_at;
  INSERT INTO safety.challenge_report_mapping_access_audit(
    report_id,operator_id,reason,result_count,occurred_at
  ) VALUES(p_report_id,p_operator_id,p_reason,v_count,p_occurred_at);
  RETURN QUERY
    SELECT mapping.subject_token,mapping.mapping_role,
           mapping.protected_context,mapping.protection_key_id
    FROM safety.challenge_report_subject_mappings mapping
    WHERE mapping.report_id=p_report_id AND mapping.expires_at>p_occurred_at
    ORDER BY mapping.mapping_role DESC,mapping.subject_token;
END $$;

CREATE OR REPLACE FUNCTION safety.purge_expired_challenge_report_subject_mappings(
  p_now timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, safety
AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM safety.challenge_report_subject_mappings WHERE expires_at<=p_now;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

CREATE OR REPLACE FUNCTION safety.pseudonymize_profile_records(
  p_family_space_id uuid, p_learning_profile_id uuid, p_subject_token text
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety AS $$
DECLARE v_count integer := 0; v_changed integer;
BEGIN
  IF p_subject_token !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid subject token'; END IF;
  UPDATE safety.classification_events SET family_space_id = NULL, learning_profile_id = NULL,
    subject_token = p_subject_token
  WHERE family_space_id = p_family_space_id AND learning_profile_id = p_learning_profile_id;
  GET DIAGNOSTICS v_changed = ROW_COUNT; v_count := v_count + v_changed;
  UPDATE safety.cases SET family_space_id = NULL, learning_profile_id = NULL,
    subject_token = p_subject_token
  WHERE family_space_id = p_family_space_id AND learning_profile_id = p_learning_profile_id;
  GET DIAGNOSTICS v_changed = ROW_COUNT; v_count := v_count + v_changed;
  UPDATE safety.challenge_reports SET
    reporter_learning_profile_id = CASE WHEN reporter_learning_profile_id = p_learning_profile_id THEN NULL ELSE reporter_learning_profile_id END,
    participant_a_learning_profile_id = CASE WHEN participant_a_learning_profile_id = p_learning_profile_id THEN NULL ELSE participant_a_learning_profile_id END,
    participant_b_learning_profile_id = CASE WHEN participant_b_learning_profile_id = p_learning_profile_id THEN NULL ELSE participant_b_learning_profile_id END,
    subject_tokens = CASE WHEN p_subject_token = ANY(subject_tokens) THEN subject_tokens ELSE array_append(subject_tokens, p_subject_token) END
  WHERE p_learning_profile_id IN (reporter_learning_profile_id, participant_a_learning_profile_id, participant_b_learning_profile_id);
  GET DIAGNOSTICS v_changed = ROW_COUNT; v_count := v_count + v_changed;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION safety.operate_case(
  p_command_id uuid,
  p_case_id uuid,
  p_operator_id text,
  p_action text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, safety AS $$
DECLARE
  v_existing safety.case_operation_audit%ROWTYPE;
  v_status text;
  v_assigned_operator_id text;
  v_claim_expires_at timestamptz;
  v_applied boolean := false;
BEGIN
  IF btrim(p_operator_id)='' OR char_length(p_operator_id)>200
     OR btrim(p_reason)='' OR char_length(p_reason)>500
     OR p_action NOT IN ('claim','escalation_failed','false_positive','release','resolved','retry_started') THEN
    RAISE EXCEPTION 'invalid safety case operation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('safety-case-command:'||p_command_id::text,0));
  SELECT * INTO v_existing
  FROM safety.case_operation_audit
  WHERE command_id=p_command_id;
  IF FOUND THEN
    IF v_existing.case_id<>p_case_id
       OR v_existing.operator_id<>p_operator_id
       OR v_existing.action<>p_action
       OR v_existing.reason<>p_reason THEN
      RAISE EXCEPTION 'safety case command id reused with different intent';
    END IF;
    RETURN v_existing.applied;
  END IF;
  SELECT status,assigned_operator_id,claim_expires_at
  INTO v_status,v_assigned_operator_id,v_claim_expires_at
  FROM safety.cases WHERE id=p_case_id FOR UPDATE;
  IF FOUND THEN
    IF p_action='claim' AND v_status IN ('open','pending_retry')
       AND (v_assigned_operator_id IS NULL OR v_assigned_operator_id=p_operator_id
         OR v_claim_expires_at IS NULL OR v_claim_expires_at<=p_occurred_at) THEN
      UPDATE safety.cases SET assigned_operator_id=p_operator_id,
        claimed_at=CASE WHEN assigned_operator_id=p_operator_id THEN COALESCE(claimed_at,p_occurred_at)
          ELSE p_occurred_at END,
        claim_expires_at=p_occurred_at+interval '10 minutes',updated_at=p_occurred_at
      WHERE id=p_case_id;
      UPDATE safety.case_notifications SET status='acknowledged',acknowledged_at=p_occurred_at
      WHERE case_id=p_case_id;
      v_applied := true;
    ELSIF p_action='release' AND v_assigned_operator_id=p_operator_id
       AND v_claim_expires_at>p_occurred_at AND v_status IN ('open','pending_retry') THEN
      UPDATE safety.cases SET assigned_operator_id=NULL,claimed_at=NULL,claim_expires_at=NULL,
        updated_at=p_occurred_at WHERE id=p_case_id;
      UPDATE safety.case_notifications SET status='pending',acknowledged_at=NULL
      WHERE case_id=p_case_id;
      v_applied := true;
    ELSIF p_action='escalation_failed' AND v_assigned_operator_id=p_operator_id
       AND v_claim_expires_at>p_occurred_at AND v_status IN ('open','pending_retry') THEN
      UPDATE safety.cases SET status='pending_retry',retry_count=retry_count+1,updated_at=p_occurred_at
      WHERE id=p_case_id;
      v_applied := true;
    ELSIF p_action='retry_started' AND v_assigned_operator_id=p_operator_id
       AND v_claim_expires_at>p_occurred_at AND v_status='pending_retry' THEN
      UPDATE safety.cases SET status='open',updated_at=p_occurred_at WHERE id=p_case_id;
      v_applied := true;
    ELSIF p_action IN ('false_positive','resolved') AND v_assigned_operator_id=p_operator_id
       AND v_claim_expires_at>p_occurred_at AND v_status IN ('open','pending_retry') THEN
      UPDATE safety.cases SET
        status=CASE WHEN p_action='false_positive' THEN 'closed_false_positive' ELSE 'resolved' END,
        claim_expires_at=NULL,updated_at=p_occurred_at
      WHERE id=p_case_id;
      v_applied := true;
    END IF;
  END IF;
  INSERT INTO safety.case_operation_audit(
    command_id,case_id,operator_id,action,reason,applied,occurred_at
  ) VALUES(p_command_id,p_case_id,p_operator_id,p_action,p_reason,v_applied,p_occurred_at);
  RETURN v_applied;
END $$;

CREATE OR REPLACE FUNCTION safety.list_actionable_cases(
  p_operator_id text,p_limit integer,p_reason text,p_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,safety AS $$
DECLARE v_result jsonb; v_case_ids uuid[];
BEGIN
  IF btrim(p_operator_id)='' OR char_length(p_operator_id)>200 OR p_limit<1 OR p_limit>100
     OR btrim(p_reason)='' OR char_length(p_reason)>500 THEN
    RAISE EXCEPTION 'invalid safety case queue request';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',item.id,'classificationId',item.classification_id,
    'familySpaceId',item.subject_token,'learningProfileId',item.subject_token,
    'ageBand',item.age_band,'source',item.source,'sourceReferenceId',item.source_reference_id,
    'sourceHash',item.source_hash,'category',item.category,'severity',item.severity,
    'guardianMayBeInvolved',item.guardian_may_be_involved,
    'assignedOperatorId',item.assigned_operator_id,'claimedAt',item.claimed_at,
    'claimExpiresAt',item.claim_expires_at,
    'status',item.case_status,'retryCount',item.retry_count,
    'createdAt',item.created_at,'updatedAt',item.updated_at,
    'notificationId',item.notification_id,'notificationStatus',item.notification_status
  ) ORDER BY item.severity_order,item.created_at,item.id),'[]'::jsonb),
    COALESCE(array_agg(item.id ORDER BY item.severity_order,item.created_at,item.id),'{}'::uuid[])
  INTO v_result,v_case_ids FROM (
    SELECT c.*,c.status AS case_status,n.id AS notification_id,n.status AS notification_status,
      CASE WHEN c.severity='critical' THEN 0 ELSE 1 END AS severity_order
    FROM safety.cases c JOIN safety.case_notifications n ON n.case_id=c.id
    WHERE c.status IN('open','pending_retry')
      AND (c.assigned_operator_id IS NULL OR c.assigned_operator_id=p_operator_id
        OR c.claim_expires_at IS NULL OR c.claim_expires_at<=p_occurred_at)
    ORDER BY severity_order,c.created_at,c.id LIMIT p_limit
  ) item;
  INSERT INTO safety.case_queue_access_audit(operator_id,case_ids,result_count,reason,occurred_at)
  VALUES(p_operator_id,v_case_ids,cardinality(v_case_ids),p_reason,p_occurred_at);
  RETURN v_result;
END$$;

CREATE OR REPLACE FUNCTION safety.authorize_and_read_support_data(
  p_grant_id uuid,
  p_support_principal_id text,
  p_family_space_id uuid,
  p_scope text,
  p_record_id text,
  p_action text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, learning, safety AS $$
DECLARE
  v_grant safety.support_access_grants%ROWTYPE;
  v_reason text := 'allowed';
  v_data jsonb := NULL;
BEGIN
  IF btrim(p_support_principal_id) = '' OR char_length(p_support_principal_id) > 200
     OR btrim(p_action) = '' OR char_length(p_action) > 200
     OR p_scope NOT IN ('learning_summary','processing_status','specified_record','technical_metadata') THEN
    RAISE EXCEPTION 'invalid support operation';
  END IF;

  -- Resolve the profile without a row lock, acquire the same profile fence used by
  -- erasure, then lock and re-read the grant. This lock order prevents support reads
  -- from crossing a committed erasure freeze without deadlocking grant revocation.
  SELECT * INTO v_grant
  FROM safety.support_access_grants
  WHERE id = p_grant_id
    AND family_space_id = p_family_space_id
    AND support_principal_id = p_support_principal_id;

  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_grant.learning_profile_id::text,0));
    SELECT * INTO v_grant
    FROM safety.support_access_grants
    WHERE id = p_grant_id
      AND family_space_id = p_family_space_id
      AND support_principal_id = p_support_principal_id
    FOR SHARE;
  END IF;

  IF NOT FOUND THEN v_reason := 'not_found';
  ELSIF EXISTS (
    SELECT 1 FROM learning.privacy_profile_freezes frozen
    WHERE frozen.learning_profile_id=v_grant.learning_profile_id
      AND frozen.family_space_id=v_grant.family_space_id
  ) THEN v_reason := 'profile_erasure_frozen';
  ELSIF v_grant.revoked_at IS NOT NULL THEN v_reason := 'revoked';
  ELSIF v_grant.expires_at <= clock_timestamp() THEN v_reason := 'expired';
  ELSIF NOT (p_scope = ANY(v_grant.scopes)) THEN v_reason := 'scope_not_allowed';
  ELSIF p_scope = 'specified_record'
    AND (p_record_id IS NULL OR NOT (p_record_id = ANY(v_grant.allowed_record_ids)))
    THEN v_reason := 'record_not_allowed';
  END IF;

  IF v_reason = 'allowed' THEN
    IF p_scope='learning_summary' THEN
      SELECT jsonb_build_object(
        'materials', (SELECT count(*) FROM learning.learning_materials WHERE learning_profile_id=v_grant.learning_profile_id),
        'openWrongItems', (SELECT count(*) FROM learning.wrong_items WHERE learning_profile_id=v_grant.learning_profile_id),
        'readyReviewCards', (SELECT count(*) FROM learning.review_cards WHERE learning_profile_id=v_grant.learning_profile_id AND status='active'),
        'masteredThemes', (SELECT count(*) FROM learning.wrong_item_theme_mastery WHERE learning_profile_id=v_grant.learning_profile_id AND status='mastered')
      ) INTO v_data;
    ELSIF p_scope='processing_status' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',job.id,'status',job.status,'errorCode',job.error_code,'updatedAt',job.updated_at
      ) ORDER BY job.updated_at DESC),'[]'::jsonb) INTO v_data
      FROM (
        SELECT id,status,error_code,updated_at
        FROM learning.processing_jobs
        WHERE family_space_id=v_grant.family_space_id
          AND learning_profile_id=v_grant.learning_profile_id
          AND (p_record_id IS NULL OR id::text=p_record_id)
        ORDER BY updated_at DESC
        LIMIT 20
      ) job;
    ELSIF p_scope='specified_record' THEN
      SELECT jsonb_build_object(
        'id',job.id,'status',job.status,'errorCode',job.error_code,
        'qualityIssues',job.quality_issues,'createdAt',job.created_at,'updatedAt',job.updated_at
      ) INTO v_data FROM learning.processing_jobs job
      WHERE job.family_space_id=v_grant.family_space_id
        AND job.learning_profile_id=v_grant.learning_profile_id
        AND job.id::text=p_record_id;
    ELSE
      SELECT jsonb_build_object(
        'grade',profile.grade,
        'processingJobs',(SELECT count(*) FROM learning.processing_jobs WHERE learning_profile_id=profile.id),
        'generatedRequests',(SELECT count(*) FROM learning.generated_learning_requests WHERE learning_profile_id=profile.id),
        'reviewRequests',(SELECT count(*) FROM learning.review_card_requests WHERE learning_profile_id=profile.id)
      ) INTO v_data FROM learning.learning_profiles profile
      WHERE profile.id=v_grant.learning_profile_id AND profile.family_space_id=v_grant.family_space_id;
    END IF;
  END IF;

  INSERT INTO safety.support_access_audit (
    grant_id, support_principal_id, scope, record_id, action, allowed, occurred_at
  ) VALUES (
    p_grant_id, p_support_principal_id, p_scope, p_record_id, p_action,
    v_reason = 'allowed', clock_timestamp()
  );

  RETURN jsonb_build_object(
    'allowed', v_reason = 'allowed',
    'expiresAt', CASE WHEN v_reason = 'allowed' THEN v_grant.expires_at ELSE NULL END,
    'familySpaceId', CASE WHEN v_reason = 'allowed' THEN v_grant.family_space_id ELSE NULL END,
    'learningProfileId', CASE WHEN v_reason = 'allowed' THEN v_grant.learning_profile_id ELSE NULL END,
    'reason', v_reason,
    'record', CASE WHEN v_reason = 'allowed' THEN v_data ELSE NULL END
  );
END $$;

REVOKE ALL ON FUNCTION safety.protect_challenge_report_identifiers(),
  safety.store_challenge_report_subject_mappings(),
  safety.queue_challenge_report_classification(),
  safety.claim_challenge_report_classifications(integer),
  safety.fail_challenge_report_classification(uuid),
  safety.complete_challenge_report_classification(uuid,jsonb,jsonb),
  safety.record_classification_and_case(jsonb,jsonb),
  safety.api_create_support_grant(jsonb), safety.api_find_support_grant(uuid),
  safety.api_revoke_support_grant(uuid,uuid,uuid,timestamptz),
  safety.api_append_support_audit(jsonb),
  safety.read_challenge_report_subject_mappings(uuid,text,text,timestamptz),
  safety.purge_expired_challenge_report_subject_mappings(timestamptz),
  safety.operate_case(uuid,uuid,text,text,text,timestamptz),
  safety.list_actionable_cases(text,integer,text,timestamptz),
  safety.authorize_and_read_support_data(uuid,text,uuid,text,text,text),
  safety.pseudonymize_profile_records(uuid,uuid,text) FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_safety_worker') THEN
    CREATE ROLE rhea_safety_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_support_reader') THEN
    CREATE ROLE rhea_support_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_safety_api') THEN
    CREATE ROLE rhea_safety_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_safety_classifier') THEN
    CREATE ROLE rhea_safety_classifier NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_safety_operator') THEN
    CREATE ROLE rhea_safety_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

ALTER ROLE rhea_safety_worker SET search_path = pg_catalog, safety;
ALTER ROLE rhea_safety_api SET search_path = pg_catalog, safety;
ALTER ROLE rhea_safety_classifier SET search_path = pg_catalog, safety;
ALTER ROLE rhea_safety_operator SET search_path = pg_catalog, safety;
ALTER ROLE rhea_support_reader SET search_path = pg_catalog, safety;
GRANT USAGE ON SCHEMA safety TO rhea_safety_worker, rhea_safety_api, rhea_safety_classifier, rhea_safety_operator, rhea_support_reader;
GRANT SELECT, INSERT ON safety.classification_events TO rhea_safety_worker;
GRANT SELECT, INSERT, UPDATE ON safety.cases TO rhea_safety_worker;
GRANT SELECT, INSERT, UPDATE ON safety.support_access_grants TO rhea_safety_worker;
GRANT INSERT ON safety.support_access_audit TO rhea_safety_worker;
GRANT USAGE, SELECT ON SEQUENCE safety.support_access_audit_id_seq TO rhea_safety_worker;
GRANT EXECUTE ON FUNCTION safety.record_classification_and_case(jsonb,jsonb) TO rhea_safety_worker, rhea_safety_api, rhea_safety_classifier;
GRANT EXECUTE ON FUNCTION safety.claim_challenge_report_classifications(integer),
  safety.fail_challenge_report_classification(uuid),
  safety.complete_challenge_report_classification(uuid,jsonb,jsonb),
  safety.purge_expired_challenge_report_subject_mappings(timestamptz) TO rhea_safety_worker;
GRANT EXECUTE ON FUNCTION safety.api_create_support_grant(jsonb),
  safety.api_find_support_grant(uuid),
  safety.api_revoke_support_grant(uuid,uuid,uuid,timestamptz),
  safety.api_append_support_audit(jsonb) TO rhea_safety_api;
GRANT EXECUTE ON FUNCTION safety.authorize_and_read_support_data(uuid,text,uuid,text,text,text) TO rhea_support_reader;
GRANT EXECUTE ON FUNCTION safety.operate_case(uuid,uuid,text,text,text,timestamptz),
  safety.list_actionable_cases(text,integer,text,timestamptz),
  safety.read_challenge_report_subject_mappings(uuid,text,text,timestamptz)
  TO rhea_safety_operator;

ALTER TABLE safety.classification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.classification_events FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.cases FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.case_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.case_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.case_queue_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.case_queue_access_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.support_access_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.support_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.support_access_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.case_operation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.case_operation_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_classification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_classification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_subject_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_subject_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_mapping_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.challenge_report_mapping_access_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY classification_events_safety_worker ON safety.classification_events
  USING (current_user = 'rhea_safety_worker')
  WITH CHECK (current_user = 'rhea_safety_worker');
CREATE POLICY cases_safety_worker ON safety.cases
  USING (current_user = 'rhea_safety_worker')
  WITH CHECK (current_user = 'rhea_safety_worker');
CREATE POLICY support_grants_safety_worker ON safety.support_access_grants
  USING (current_user = 'rhea_safety_worker')
  WITH CHECK (current_user = 'rhea_safety_worker');
CREATE POLICY support_audit_safety_worker ON safety.support_access_audit
  USING (current_user = 'rhea_safety_worker')
  WITH CHECK (current_user = 'rhea_safety_worker');
CREATE POLICY case_operation_audit_operator ON safety.case_operation_audit
  USING (current_user = 'rhea_safety_operator')
  WITH CHECK (current_user = 'rhea_safety_operator');
CREATE POLICY challenge_report_subject_mappings_safety_worker
  ON safety.challenge_report_subject_mappings
  USING (current_user = 'rhea_safety_worker')
  WITH CHECK (current_user = 'rhea_safety_worker');
CREATE POLICY challenge_report_mapping_audit_operator
  ON safety.challenge_report_mapping_access_audit
  USING (current_user = 'rhea_safety_operator')
  WITH CHECK (current_user = 'rhea_safety_operator');

REVOKE ALL ON ALL TABLES IN SCHEMA safety FROM
  rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app,
  rhea_quality_runtime, rhea_quality_governance, rhea_lineage_runtime,
  rhea_learning_progress_app, rhea_reporting_app, rhea_challenge_app;
REVOKE ALL ON SCHEMA safety FROM
  rhea_learning_app, rhea_assessment_app, rhea_generated_learning_app,
  rhea_quality_runtime, rhea_quality_governance, rhea_lineage_runtime,
  rhea_learning_progress_app, rhea_reporting_app, rhea_challenge_app;

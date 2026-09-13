CREATE TABLE learning.privacy_tasks (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL,
  learning_profile_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export','erasure')),
  status text NOT NULL CHECK (status IN ('completed','failed','pending','processing','retry_scheduled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text,
  target_receipts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(target_receipts)='object'),
  download jsonb,
  requested_by_guardian_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL CHECK (deadline_at <= created_at + interval '30 days'),
  completed_at timestamptz
);

CREATE TABLE learning.erasure_certificates (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES learning.privacy_tasks(id),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 1000),
  target_names text[] NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE TABLE learning.erasure_tombstones (
  task_id uuid NOT NULL REFERENCES learning.privacy_tasks(id),
  subject_token text PRIMARY KEY CHECK (subject_token ~ '^[0-9a-f]{64}$'),
  completion_certificate_id uuid NOT NULL REFERENCES learning.erasure_certificates(id),
  target_names text[] NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE TABLE learning.profile_key_wraps (
  learning_profile_id uuid PRIMARY KEY REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  kms_key_id text NOT NULL CHECK (char_length(kms_key_id) BETWEEN 1 AND 500),
  wrapped_key bytea,
  destroyed_at timestamptz,
  CHECK (
    (destroyed_at IS NULL AND wrapped_key IS NOT NULL)
    OR (destroyed_at IS NOT NULL AND wrapped_key IS NULL)
  )
);

ALTER TABLE learning.recognition_candidates
  ADD COLUMN provider_deletion_handle text;

CREATE TABLE learning.privacy_profile_freezes (
  learning_profile_id uuid PRIMARY KEY REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  frozen_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason = 'erasure_requested'),
  FOREIGN KEY (learning_profile_id, family_space_id)
    REFERENCES learning.learning_profiles(id, family_space_id)
);

CREATE TABLE learning.privacy_export_blobs (
  object_key text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES learning.privacy_tasks(id) ON DELETE CASCADE,
  encrypted_payload bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX privacy_tasks_status_deadline_idx
  ON learning.privacy_tasks (status, deadline_at, id);
CREATE UNIQUE INDEX privacy_tasks_one_active_erasure_idx
  ON learning.privacy_tasks (family_space_id, learning_profile_id, kind)
  WHERE kind='erasure' AND status IN ('pending','processing','retry_scheduled');

CREATE OR REPLACE FUNCTION learning.privacy_profile_in_family(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT EXISTS (
    SELECT 1 FROM learning.learning_profiles
    WHERE id=p_learning_profile_id AND family_space_id=p_family_space_id
  )
$$;

CREATE OR REPLACE FUNCTION learning.freeze_profile_for_erasure(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_learning_profile_id::text,0));
  IF NOT EXISTS (
    SELECT 1 FROM learning.learning_profiles
    WHERE id = p_learning_profile_id AND family_space_id = p_family_space_id
  ) THEN RETURN false; END IF;
  -- Cancel open uploads while the profile fence is held and before publishing
  -- the freeze marker. The general frozen-write trigger deliberately rejects
  -- all later upload-session updates, including attempted reopenings.
  UPDATE learning.upload_sessions
  SET status='canceled'
  WHERE learning_profile_id=p_learning_profile_id AND status='open';
  INSERT INTO learning.privacy_profile_freezes
    (learning_profile_id,family_space_id,frozen_at,reason)
  VALUES (p_learning_profile_id,p_family_space_id,now(),'erasure_requested')
  ON CONFLICT (learning_profile_id) DO NOTHING;
  UPDATE safety.support_access_grants
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE learning_profile_id = p_learning_profile_id
    AND family_space_id = p_family_space_id;
  UPDATE learning.sessions
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE learning_profile_id = p_learning_profile_id;
  UPDATE learning.processing_jobs
  SET status = 'canceled', updated_at = now(),
      error_code = NULL, cancellation_version = cancellation_version + 1,
      revision = revision + 1
  WHERE learning_profile_id = p_learning_profile_id
    AND status NOT IN ('completed','canceled','failed','unavailable');
  UPDATE learning.domain_outbox
  SET published_at=COALESCE(published_at,now())
  WHERE learning_profile_id=p_learning_profile_id
    AND event_type<>'privacy.task.requested';
  UPDATE learning.generated_learning_requests
  SET status='unavailable', unavailable_reason='CONSENT_WITHDRAWN',
      processing_lease_expires_at=NULL, state_revision=state_revision+1, updated_at=now()
  WHERE learning_profile_id=p_learning_profile_id AND status IN ('queued','generating');
  UPDATE learning.suggested_assessments
  SET status='unavailable', unavailable_reason='CONSENT_WITHDRAWN',
      processing_lease_expires_at=NULL, state_revision=state_revision+1, updated_at=now()
  WHERE learning_profile_id=p_learning_profile_id AND status IN ('queued','generating');
  UPDATE learning.review_card_requests
  SET status='unavailable', unavailable_reason='CONSENT_WITHDRAWN',
      processing_lease_expires_at=NULL, state_revision=state_revision+1, updated_at=now()
  WHERE learning_profile_id=p_learning_profile_id AND status IN ('queued','generating');
  DELETE FROM learning.random_match_entries
  WHERE learning_profile_id = p_learning_profile_id;
  DELETE FROM learning.challenge_matches
  WHERE participant_a_learning_profile_id = p_learning_profile_id
     OR participant_b_learning_profile_id = p_learning_profile_id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION learning.profile_accepts_upload(p_learning_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM learning.privacy_profile_freezes
    WHERE learning_profile_id=p_learning_profile_id
  )
$$;

CREATE OR REPLACE FUNCTION learning.reject_frozen_profile_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF NEW.learning_profile_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.learning_profile_id::text,0));
  END IF;
  IF NEW.learning_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM learning.privacy_profile_freezes frozen
    WHERE frozen.learning_profile_id=NEW.learning_profile_id
  ) THEN
    RAISE EXCEPTION 'PROFILE_FROZEN_FOR_ERASURE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sessions_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.sessions
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER upload_sessions_reject_frozen_profile
  BEFORE INSERT OR UPDATE ON learning.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER upload_pages_reject_frozen_profile
  BEFORE INSERT OR UPDATE ON learning.upload_pages
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER processing_jobs_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER generated_requests_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.generated_learning_requests
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER suggested_assessments_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.suggested_assessments
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER review_requests_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.review_card_requests
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();
CREATE TRIGGER random_match_reject_frozen_profile
  BEFORE INSERT OR UPDATE OF learning_profile_id ON learning.random_match_entries
  FOR EACH ROW EXECUTE FUNCTION learning.reject_frozen_profile_write();

CREATE OR REPLACE FUNCTION learning.export_profile_data(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT jsonb_build_object(
    'formatVersion', 'rhea-profile-export-v3',
    'profile', to_jsonb(profile) - 'pin_hash',
    'coursePaths', COALESCE((SELECT jsonb_agg(to_jsonb(path) ORDER BY path.created_at,path.id)
                FROM learning.course_paths path
                WHERE path.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'learningUnits', COALESCE((SELECT jsonb_agg(to_jsonb(unit_row) ORDER BY unit_row.created_at,unit_row.id)
                FROM learning.learning_units unit_row
                WHERE unit_row.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'knowledgePoints', COALESCE((SELECT jsonb_agg(to_jsonb(point) ORDER BY point.created_at,point.id)
                FROM learning.knowledge_points point
                WHERE point.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'materials', COALESCE((SELECT jsonb_agg(to_jsonb(material))
                FROM learning.learning_materials material
                WHERE material.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'classificationVersions', COALESCE((SELECT jsonb_agg(to_jsonb(classification) ORDER BY classification.changed_at,classification.revision)
                FROM learning.classification_versions classification
                WHERE classification.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'classificationKnowledgePoints', COALESCE((SELECT jsonb_agg(to_jsonb(link) ORDER BY link.classification_version_id,link.position)
                FROM learning.classification_knowledge_points link
                WHERE link.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'learningSourceVersions', COALESCE((SELECT jsonb_agg(to_jsonb(source_version) ORDER BY source_version.created_at,source_version.version_number)
                FROM learning.learning_source_versions source_version
                WHERE source_version.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'basisSelectionVersions', COALESCE((SELECT jsonb_agg(to_jsonb(basis) ORDER BY basis.selected_at,basis.version)
                FROM learning.basis_selection_versions basis
                WHERE basis.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'uploadSessions', COALESCE((SELECT jsonb_agg(to_jsonb(session))
                FROM learning.upload_sessions session
                WHERE session.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'uploadPages', COALESCE((SELECT jsonb_agg(to_jsonb(page) - 'upload_token_hash')
                FROM learning.upload_pages page
                WHERE page.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'processingJobs', COALESCE((SELECT jsonb_agg(to_jsonb(job))
                FROM learning.processing_jobs job
                WHERE job.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'recognitionCandidates', COALESCE((SELECT jsonb_agg(to_jsonb(candidate))
                FROM learning.recognition_candidates candidate
                WHERE candidate.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'confirmedContentVersions', COALESCE((SELECT jsonb_agg(to_jsonb(content))
                FROM learning.confirmed_content_versions content
                WHERE content.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'assessments', COALESCE((SELECT jsonb_agg(to_jsonb(assessment))
                FROM learning.objective_assessments assessment
                WHERE assessment.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'assessmentVersions', COALESCE((SELECT jsonb_agg(to_jsonb(version))
                FROM learning.objective_assessment_versions version
                WHERE version.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'assessmentDisputes', COALESCE((SELECT jsonb_agg(to_jsonb(dispute))
                FROM learning.assessment_disputes dispute
                WHERE dispute.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'assessmentDisputeResolutions', COALESCE((SELECT jsonb_agg(to_jsonb(resolution))
                FROM learning.assessment_dispute_resolutions resolution
                WHERE resolution.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'suggestedAssessments', COALESCE((SELECT jsonb_agg(to_jsonb(suggestion))
                FROM learning.suggested_assessments suggestion
                WHERE suggestion.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'generatedLearningRequests', COALESCE((SELECT jsonb_agg(to_jsonb(request))
                FROM learning.generated_learning_requests request
                WHERE request.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'generatedLearningVersions', COALESCE((SELECT jsonb_agg(to_jsonb(version))
                FROM learning.generated_learning_content_versions version
                WHERE version.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'generatedLearningSourceEdges', COALESCE((SELECT jsonb_agg(to_jsonb(edge) ORDER BY edge.generated_version_id,edge.position)
                FROM learning.generated_learning_source_edges edge
                WHERE edge.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'generatedLearningHintUsages', COALESCE((SELECT jsonb_agg(to_jsonb(usage) ORDER BY usage.occurred_at,usage.id)
                FROM learning.generated_learning_hint_usages usage
                WHERE usage.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'wrongItems', COALESCE((SELECT jsonb_agg(to_jsonb(item))
                FROM learning.wrong_items item
                WHERE item.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'wrongItemReasonHistory', COALESCE((SELECT jsonb_agg(to_jsonb(revision))
                FROM learning.wrong_item_reason_revisions revision
                WHERE revision.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'correctionAttempts', COALESCE((SELECT jsonb_agg(to_jsonb(attempt))
                FROM learning.immediate_correction_attempts attempt
                WHERE attempt.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'reviewCardRequests', COALESCE((SELECT jsonb_agg(to_jsonb(request))
                FROM learning.review_card_requests request
                WHERE request.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'reviewCards', COALESCE((SELECT jsonb_agg(to_jsonb(card))
                FROM learning.review_cards card
                WHERE card.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'reviewSessions', COALESCE((SELECT jsonb_agg(to_jsonb(session))
                FROM learning.short_review_sessions session
                WHERE session.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'reviewAttempts', COALESCE((SELECT jsonb_agg(to_jsonb(attempt))
                FROM learning.review_card_attempts attempt
                WHERE attempt.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'learningEvidence', COALESCE((SELECT jsonb_agg(to_jsonb(evidence))
                FROM learning.learning_evidence evidence
                WHERE evidence.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'themeMastery', COALESCE((SELECT jsonb_agg(to_jsonb(mastery))
                FROM learning.wrong_item_theme_mastery mastery
                WHERE mastery.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'masteryTransitions', COALESCE((SELECT jsonb_agg(to_jsonb(transition))
                FROM learning.theme_mastery_transitions transition
                WHERE transition.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'partnerInvites', COALESCE((SELECT jsonb_agg(to_jsonb(invite) - 'code_hash')
                FROM learning.partner_invites invite
                WHERE invite.creator_learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'partnerRelations', COALESCE((SELECT jsonb_agg(relation.record)
                FROM learning.partner_relations relation
                WHERE p_learning_profile_id IN (relation.participant_a_learning_profile_id, relation.participant_b_learning_profile_id)), '[]'::jsonb),
    'challengeAttempts', COALESCE((SELECT jsonb_agg(to_jsonb(attempt))
                FROM learning.challenge_attempts attempt
                WHERE attempt.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'challengeResults', COALESCE((SELECT jsonb_agg(result.record)
                FROM learning.deidentified_challenge_results result
                WHERE result.owner_learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'growthEvents', COALESCE((SELECT jsonb_agg(to_jsonb(event))
                FROM learning.gamification_events event
                WHERE event.learning_profile_id = p_learning_profile_id), '[]'::jsonb),
    'sourceHistory', COALESCE((SELECT jsonb_agg(to_jsonb(revision))
                FROM learning.source_revisions revision
                WHERE revision.learning_profile_id = profile.id), '[]'::jsonb),
    'sourceHeads', COALESCE((SELECT jsonb_agg(to_jsonb(head) ORDER BY head.source_kind,head.source_id)
                FROM learning.source_heads head
                WHERE head.learning_profile_id = profile.id), '[]'::jsonb),
    'derivedArtifacts', COALESCE((SELECT jsonb_agg(to_jsonb(artifact) ORDER BY artifact.published_at,artifact.artifact_id)
                FROM learning.derived_artifacts artifact
                WHERE artifact.learning_profile_id = profile.id), '[]'::jsonb),
    'derivedArtifactHeads', COALESCE((SELECT jsonb_agg(to_jsonb(head) ORDER BY head.artifact_kind,head.artifact_id)
                FROM learning.derived_artifact_heads head
                WHERE head.learning_profile_id = profile.id), '[]'::jsonb),
    'derivationEdges', COALESCE((SELECT jsonb_agg(to_jsonb(edge) ORDER BY edge.artifact_kind,edge.artifact_id,edge.source_kind,edge.source_id)
                FROM learning.derivation_edges edge
                WHERE edge.learning_profile_id = profile.id), '[]'::jsonb),
    'rebuildJobs', COALESCE((SELECT jsonb_agg(to_jsonb(job) ORDER BY job.created_at,job.id)
                FROM learning.rebuild_jobs job
                WHERE job.learning_profile_id = profile.id), '[]'::jsonb),
    'stateHistoryIncluded', true
  )
  FROM learning.learning_profiles profile
  WHERE profile.id = p_learning_profile_id
    AND profile.family_space_id = p_family_space_id
$$;

CREATE OR REPLACE FUNCTION learning.destroy_profile_key_wrap(
  p_learning_profile_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  UPDATE learning.profile_key_wraps
  SET wrapped_key = NULL, destroyed_at = COALESCE(destroyed_at, now())
  WHERE learning_profile_id = p_learning_profile_id;
  RETURN NOT EXISTS (
    SELECT 1 FROM learning.profile_key_wraps
    WHERE learning_profile_id = p_learning_profile_id AND wrapped_key IS NOT NULL
  );
END
$$;

CREATE OR REPLACE FUNCTION learning.get_profile_key_wrap(
  p_family_space_id uuid, p_learning_profile_id uuid
)
RETURNS TABLE(kms_key_id text, wrapped_key bytea)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT key_wrap.kms_key_id,key_wrap.wrapped_key
  FROM learning.profile_key_wraps key_wrap
  JOIN learning.learning_profiles profile ON profile.id=key_wrap.learning_profile_id
  WHERE key_wrap.learning_profile_id=p_learning_profile_id
    AND profile.family_space_id=p_family_space_id
    AND key_wrap.destroyed_at IS NULL AND key_wrap.wrapped_key IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION learning.create_profile_key_wrap(
  p_family_space_id uuid,
  p_learning_profile_id uuid,
  p_kms_key_id text,
  p_wrapped_key bytea
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM learning.learning_profiles
    WHERE id=p_learning_profile_id AND family_space_id=p_family_space_id
  ) OR EXISTS (
    SELECT 1 FROM learning.privacy_profile_freezes
    WHERE learning_profile_id=p_learning_profile_id
      AND family_space_id=p_family_space_id
  ) THEN RETURN false; END IF;
  INSERT INTO learning.profile_key_wraps
    (learning_profile_id,kms_key_id,wrapped_key,destroyed_at)
  VALUES (p_learning_profile_id,p_kms_key_id,p_wrapped_key,NULL)
  ON CONFLICT (learning_profile_id) DO NOTHING;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION learning.resolve_profile_family_for_crypto(
  p_learning_profile_id uuid
)
RETURNS TABLE(family_space_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT profile.family_space_id
  FROM learning.learning_profiles profile
  WHERE profile.id=p_learning_profile_id
$$;

CREATE OR REPLACE FUNCTION learning.delete_expired_privacy_exports()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM learning.privacy_export_blobs WHERE expires_at <= now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

CREATE OR REPLACE FUNCTION learning.list_profile_object_keys(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS TABLE(object_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT page.object_key
  FROM learning.upload_pages page
  JOIN learning.upload_sessions session_row ON session_row.id = page.upload_session_id
  WHERE session_row.family_space_id = p_family_space_id
    AND page.learning_profile_id = p_learning_profile_id
  ORDER BY page.object_key
$$;

CREATE OR REPLACE FUNCTION learning.list_profile_outbox_references(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS TABLE(event_id text, aggregate_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT event.id::text,event.aggregate_id::text
  FROM learning.domain_outbox event
  WHERE event.family_space_id=p_family_space_id
    AND event.learning_profile_id=p_learning_profile_id
  ORDER BY event.occurred_at,event.id
$$;

CREATE OR REPLACE FUNCTION learning.list_profile_vendor_references(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS TABLE(provider_kind text, reference_value text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, learning
AS $$
  SELECT DISTINCT reference.provider_kind, reference.reference_value
  FROM (
    SELECT CASE
      WHEN candidate.provider_deletion_handle IS NULL OR candidate.provider_deletion_handle = ''
        THEN 'ocr_missing'
      ELSE 'ocr'
    END AS provider_kind,
    COALESCE(NULLIF(candidate.provider_deletion_handle, ''), candidate.id::text) AS reference_value
    FROM learning.recognition_candidates candidate
    JOIN learning.processing_jobs job ON job.id = candidate.job_id
    WHERE job.family_space_id = p_family_space_id
      AND candidate.learning_profile_id = p_learning_profile_id
    UNION ALL
    SELECT 'llm', run ->> 'externalTraceId'
    FROM learning.generated_learning_requests request_row
    CROSS JOIN LATERAL jsonb_array_elements(request_row.model_runs) run
    WHERE request_row.family_space_id = p_family_space_id
      AND request_row.learning_profile_id = p_learning_profile_id
    UNION ALL
    SELECT 'llm', run ->> 'externalTraceId'
    FROM learning.review_card_requests request_row
    CROSS JOIN LATERAL jsonb_array_elements(request_row.model_runs) run
    WHERE request_row.family_space_id = p_family_space_id
      AND request_row.learning_profile_id = p_learning_profile_id
    UNION ALL
    SELECT 'llm', request_row.model_run ->> 'externalTraceId'
    FROM learning.suggested_assessments request_row
    WHERE request_row.family_space_id = p_family_space_id
      AND request_row.learning_profile_id = p_learning_profile_id
      AND request_row.model_run IS NOT NULL
  ) reference
  WHERE reference.reference_value IS NOT NULL
    AND reference.reference_value <> ''
  ORDER BY reference.provider_kind, reference.reference_value
$$;

CREATE OR REPLACE FUNCTION learning.delete_profile_active_data(
  p_family_space_id uuid,
  p_learning_profile_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, learning, safety
AS $$
BEGIN
  DELETE FROM learning.privacy_export_blobs export_blob
  USING learning.privacy_tasks task
  WHERE export_blob.task_id = task.id
    AND task.family_space_id = p_family_space_id
    AND task.learning_profile_id = p_learning_profile_id;
  DELETE FROM safety.support_access_audit audit
  USING safety.support_access_grants grant_row
  WHERE audit.grant_id = grant_row.id
    AND grant_row.learning_profile_id = p_learning_profile_id;
  DELETE FROM safety.support_access_grants WHERE learning_profile_id = p_learning_profile_id;
  -- Safety classification and escalation records follow their own Shanghai retention policy.
  -- They are intentionally not deleted as ordinary learning data by this function.
  DELETE FROM learning.sessions WHERE learning_profile_id = p_learning_profile_id;
  DELETE FROM learning.learning_profiles
  WHERE id = p_learning_profile_id AND family_space_id = p_family_space_id;
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM learning.privacy_tasks
    WHERE kind='erasure' AND family_space_id=p_family_space_id
      AND learning_profile_id=p_learning_profile_id
  );
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_privacy_worker') THEN
    CREATE ROLE rhea_privacy_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_privacy_api') THEN
    CREATE ROLE rhea_privacy_api
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_profile_crypto') THEN
    CREATE ROLE rhea_profile_crypto
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhea_profile_crypto_reader') THEN
    CREATE ROLE rhea_profile_crypto_reader
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE rhea_privacy_worker SET search_path = pg_catalog, learning;
ALTER ROLE rhea_privacy_api SET search_path = pg_catalog, learning;
ALTER ROLE rhea_profile_crypto_reader SET search_path = pg_catalog, learning;
GRANT USAGE ON SCHEMA learning TO rhea_privacy_worker, rhea_privacy_api,
  rhea_profile_crypto, rhea_profile_crypto_reader;

ALTER TABLE learning.privacy_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.privacy_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.erasure_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.erasure_certificates FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.erasure_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.erasure_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.profile_key_wraps ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.profile_key_wraps FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.privacy_profile_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.privacy_profile_freezes FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.privacy_export_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.privacy_export_blobs FORCE ROW LEVEL SECURITY;

CREATE POLICY privacy_tasks_worker_access ON learning.privacy_tasks
  USING (current_user = 'rhea_privacy_worker')
  WITH CHECK (current_user = 'rhea_privacy_worker');
CREATE POLICY privacy_tasks_api_select ON learning.privacy_tasks
  FOR SELECT USING (
    current_user = 'rhea_privacy_api'
    AND family_space_id::text=current_setting('rhea.family_space_id',true)
  );
CREATE POLICY privacy_tasks_api_insert ON learning.privacy_tasks
  FOR INSERT WITH CHECK (
    current_user = 'rhea_privacy_api' AND status='pending'
    AND family_space_id::text=current_setting('rhea.family_space_id',true)
  );
CREATE POLICY erasure_certificates_worker_access ON learning.erasure_certificates
  USING (current_user = 'rhea_privacy_worker')
  WITH CHECK (current_user = 'rhea_privacy_worker');
CREATE POLICY erasure_certificates_api_select ON learning.erasure_certificates
  FOR SELECT USING (
    current_user = 'rhea_privacy_api' AND EXISTS (
      SELECT 1 FROM learning.privacy_tasks task
      WHERE task.id=erasure_certificates.task_id
        AND task.family_space_id::text=current_setting('rhea.family_space_id',true)
    )
  );
CREATE POLICY erasure_tombstones_worker_access ON learning.erasure_tombstones
  USING (current_user = 'rhea_privacy_worker')
  WITH CHECK (current_user = 'rhea_privacy_worker');
CREATE POLICY profile_key_wraps_worker_access ON learning.profile_key_wraps
  USING (current_user IN ('rhea_privacy_worker','rhea_profile_crypto'))
  WITH CHECK (current_user IN ('rhea_privacy_worker','rhea_profile_crypto'));
CREATE POLICY privacy_profile_freezes_worker_access ON learning.privacy_profile_freezes
  USING (current_user = 'rhea_privacy_worker')
  WITH CHECK (current_user = 'rhea_privacy_worker');
CREATE POLICY privacy_export_blobs_worker_access ON learning.privacy_export_blobs
  USING (current_user = 'rhea_privacy_worker')
  WITH CHECK (current_user = 'rhea_privacy_worker');
CREATE POLICY privacy_export_blobs_api_select ON learning.privacy_export_blobs
  FOR SELECT USING (
    current_user = 'rhea_privacy_api' AND EXISTS (
      SELECT 1 FROM learning.privacy_tasks task
      WHERE task.id=privacy_export_blobs.task_id
        AND task.family_space_id::text=current_setting('rhea.family_space_id',true)
    )
  );
CREATE POLICY domain_outbox_privacy_task_insert ON learning.domain_outbox
  FOR INSERT
  WITH CHECK (
    current_user IN ('rhea_privacy_worker','rhea_privacy_api')
    AND aggregate_type = 'privacy_task'
    AND event_type = 'privacy.task.requested'
    AND id = aggregate_id
    AND EXISTS (
      SELECT 1 FROM learning.privacy_tasks task
      WHERE task.id = learning.domain_outbox.id
        AND task.family_space_id = learning.domain_outbox.family_space_id
        AND task.learning_profile_id = learning.domain_outbox.learning_profile_id
    )
  );

REVOKE ALL ON learning.privacy_tasks, learning.erasure_certificates,
  learning.erasure_tombstones, learning.profile_key_wraps,
  learning.privacy_profile_freezes, learning.privacy_export_blobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON learning.privacy_tasks TO rhea_privacy_worker;
GRANT SELECT, INSERT ON learning.erasure_certificates,
  learning.erasure_tombstones TO rhea_privacy_worker;
GRANT UPDATE ON learning.erasure_tombstones TO rhea_privacy_worker;
GRANT SELECT, INSERT, UPDATE ON learning.profile_key_wraps TO rhea_privacy_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON learning.privacy_profile_freezes TO rhea_privacy_worker;
GRANT SELECT, INSERT, DELETE ON learning.privacy_export_blobs TO rhea_privacy_worker;
GRANT INSERT ON learning.domain_outbox TO rhea_privacy_worker;
GRANT SELECT, INSERT ON learning.privacy_tasks TO rhea_privacy_api;
GRANT SELECT ON learning.erasure_certificates, learning.privacy_export_blobs TO rhea_privacy_api;
GRANT INSERT ON learning.domain_outbox TO rhea_privacy_api;
REVOKE ALL ON FUNCTION learning.freeze_profile_for_erasure(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.profile_accepts_upload(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.privacy_profile_in_family(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.export_profile_data(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.destroy_profile_key_wrap(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.get_profile_key_wrap(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.create_profile_key_wrap(uuid,uuid,text,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.resolve_profile_family_for_crypto(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.delete_expired_privacy_exports() FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.reject_frozen_profile_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.delete_profile_active_data(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.list_profile_object_keys(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.list_profile_outbox_references(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION learning.list_profile_vendor_references(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.freeze_profile_for_erasure(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.profile_accepts_upload(uuid) TO
  rhea_learning_app, rhea_profile_crypto, rhea_profile_crypto_reader;
GRANT EXECUTE ON FUNCTION learning.privacy_profile_in_family(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.export_profile_data(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.destroy_profile_key_wrap(uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.get_profile_key_wrap(uuid,uuid) TO
  rhea_profile_crypto, rhea_profile_crypto_reader;
GRANT EXECUTE ON FUNCTION learning.create_profile_key_wrap(uuid,uuid,text,bytea) TO rhea_profile_crypto;
GRANT EXECUTE ON FUNCTION learning.resolve_profile_family_for_crypto(uuid) TO
  rhea_profile_crypto, rhea_profile_crypto_reader;
GRANT EXECUTE ON FUNCTION learning.delete_expired_privacy_exports() TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.delete_profile_active_data(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.list_profile_object_keys(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.list_profile_outbox_references(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.list_profile_vendor_references(uuid, uuid) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION safety.pseudonymize_profile_records(uuid,uuid,text) TO rhea_privacy_worker;
GRANT EXECUTE ON FUNCTION learning.freeze_profile_for_erasure(uuid, uuid),
  learning.privacy_profile_in_family(uuid, uuid) TO rhea_privacy_api;

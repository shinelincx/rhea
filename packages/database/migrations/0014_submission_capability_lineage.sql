ALTER TABLE learning.recognition_candidates
  ADD COLUMN finished_at timestamptz;

UPDATE learning.recognition_candidates
SET finished_at = created_at
WHERE finished_at IS NULL;

ALTER TABLE learning.recognition_candidates
  ALTER COLUMN finished_at SET NOT NULL;

ALTER TABLE learning.processing_jobs
  DROP CONSTRAINT processing_jobs_status_check,
  ADD CONSTRAINT processing_jobs_status_check CHECK (status IN (
    'queued', 'security_check', 'quality_check', 'recognizing',
    'awaiting_confirmation', 'completed', 'unavailable', 'failed', 'canceled'
  )),
  DROP CONSTRAINT processing_jobs_error_code_check,
  ADD CONSTRAINT processing_jobs_error_code_check CHECK (
    error_code IS NULL OR error_code IN (
      'CAPABILITY_UNAVAILABLE', 'FILE_UNSAFE', 'OCR_FAILED', 'UPLOAD_INCOMPLETE'
    )
  );

ALTER TABLE learning.processing_jobs
  ADD CONSTRAINT processing_jobs_family_profile_identity
    UNIQUE (id, family_space_id, learning_profile_id);

ALTER TABLE learning.recognition_candidates
  ADD COLUMN family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id),
  ADD COLUMN capability_key text NOT NULL,
  ADD COLUMN capability_kind text NOT NULL,
  ADD COLUMN capability_version_id text NOT NULL,
  ADD COLUMN authorization_decision_id text NOT NULL,
  ADD COLUMN authorization_containment_epoch bigint NOT NULL,
  ADD COLUMN authorization_family_space_hash text NOT NULL,
  ADD COLUMN capability_snapshot jsonb NOT NULL,
  ADD CONSTRAINT recognition_candidates_capability_kind_check
    CHECK (capability_kind = 'ocr'),
  ADD CONSTRAINT recognition_candidates_authorization_epoch_check
    CHECK (authorization_containment_epoch >= 0),
  ADD CONSTRAINT recognition_candidates_job_family_profile_fk
    FOREIGN KEY (job_id, family_space_id, learning_profile_id)
    REFERENCES learning.processing_jobs(id, family_space_id, learning_profile_id),
  ADD CONSTRAINT recognition_candidates_authorization_family_check CHECK (
    authorization_family_space_hash =
      encode(sha256(convert_to(family_space_id::text, 'UTF8')), 'hex')
  ),
  ADD CONSTRAINT recognition_candidates_capability_snapshot_check CHECK (
    jsonb_typeof(capability_snapshot) = 'object'
    AND capability_snapshot ->> 'id' = capability_version_id
    AND capability_snapshot ->> 'capabilityKey' = capability_key
    AND capability_snapshot ->> 'kind' = capability_kind
    AND capability_snapshot #>> '{adapter,version}' = adapter_version
    AND length(btrim(capability_snapshot #>> '{provider,id}')) > 0
    AND length(btrim(capability_snapshot #>> '{provider,version}')) > 0
    AND length(btrim(capability_snapshot #>> '{modelOrEngine,id}')) > 0
    AND length(btrim(capability_snapshot #>> '{modelOrEngine,version}')) > 0
    AND capability_snapshot #>> '{promptOrConfig,kind}' = 'config'
    AND length(btrim(capability_snapshot #>> '{promptOrConfig,version}')) > 0
    AND length(btrim(capability_snapshot ->> 'policyVersion')) > 0
    AND length(btrim(capability_snapshot ->> 'region')) > 0
  ),
  ADD CONSTRAINT recognition_candidates_capability_fk
    FOREIGN KEY (capability_version_id, capability_key, capability_kind)
    REFERENCES metrics.capability_versions(id, capability_key, kind),
  ADD CONSTRAINT recognition_candidates_authorization_fk
    FOREIGN KEY (
      authorization_decision_id, capability_version_id,
      authorization_containment_epoch, authorization_family_space_hash
    ) REFERENCES metrics.authorization_decisions(
      id, primary_version_id, containment_epoch, family_space_hash
    );

CREATE INDEX recognition_candidates_capability_lineage_idx
  ON learning.recognition_candidates (
    capability_version_id, authorization_decision_id,
    authorization_containment_epoch, authorization_family_space_hash
  );

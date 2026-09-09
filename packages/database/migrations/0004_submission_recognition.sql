CREATE TABLE learning.upload_sessions (
  id uuid PRIMARY KEY,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('open', 'submitted', 'canceled')),
  job_id uuid,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE learning.upload_pages (
  id uuid PRIMARY KEY,
  upload_session_id uuid NOT NULL REFERENCES learning.upload_sessions(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  declared_mime_type text NOT NULL,
  observed_mime_type text,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_order integer NOT NULL CHECK (page_order >= 0),
  rotation integer NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
  crop jsonb,
  width integer,
  height integer,
  object_key text NOT NULL UNIQUE,
  upload_token_hash text NOT NULL,
  uploaded_at timestamptz,
  UNIQUE (upload_session_id, page_order)
);

CREATE TABLE learning.processing_jobs (
  id uuid PRIMARY KEY,
  upload_session_id uuid NOT NULL UNIQUE REFERENCES learning.upload_sessions(id) ON DELETE CASCADE,
  family_space_id uuid NOT NULL REFERENCES learning.family_spaces(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'queued', 'security_check', 'quality_check', 'recognizing',
    'awaiting_confirmation', 'completed', 'failed', 'canceled'
  )),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'FILE_UNSAFE', 'OCR_FAILED', 'UPLOAD_INCOMPLETE'
  )),
  quality_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  cancellation_version integer NOT NULL DEFAULT 0 CHECK (cancellation_version >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE learning.upload_sessions
  ADD CONSTRAINT upload_sessions_job_fk
  FOREIGN KEY (job_id) REFERENCES learning.processing_jobs(id);

CREATE TABLE learning.recognition_candidates (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES learning.processing_jobs(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  adapter_version text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  regions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE learning.confirmed_content_versions (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES learning.processing_jobs(id) ON DELETE CASCADE,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  source_candidate_id uuid NOT NULL REFERENCES learning.recognition_candidates(id),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  regions jsonb NOT NULL,
  confirmed_by_learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id),
  confirmed_at timestamptz NOT NULL,
  UNIQUE (job_id, version)
);

CREATE TABLE learning.raw_asset_deletions (
  id bigserial PRIMARY KEY,
  learning_profile_id uuid NOT NULL REFERENCES learning.learning_profiles(id) ON DELETE CASCADE,
  object_key_hash text NOT NULL,
  deletion_proof text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (learning_profile_id, object_key_hash)
);

CREATE INDEX upload_sessions_profile_time_idx
  ON learning.upload_sessions (learning_profile_id, created_at DESC);
CREATE INDEX processing_jobs_profile_time_idx
  ON learning.processing_jobs (learning_profile_id, updated_at DESC);

ALTER TABLE learning.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.upload_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.upload_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.upload_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.processing_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.recognition_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.recognition_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.confirmed_content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.confirmed_content_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE learning.raw_asset_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning.raw_asset_deletions FORCE ROW LEVEL SECURITY;

CREATE POLICY upload_sessions_profile_isolation ON learning.upload_sessions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY upload_pages_profile_isolation ON learning.upload_pages
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY processing_jobs_profile_isolation ON learning.processing_jobs
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY recognition_candidates_profile_isolation ON learning.recognition_candidates
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY confirmed_content_profile_isolation ON learning.confirmed_content_versions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));
CREATE POLICY raw_asset_deletions_profile_isolation ON learning.raw_asset_deletions
  USING (learning_profile_id::text = current_setting('rhea.learning_profile_id', true))
  WITH CHECK (learning_profile_id::text = current_setting('rhea.learning_profile_id', true));

CREATE TABLE metrics.provider_capabilities(
  capability_version_id text PRIMARY KEY,provider_id text NOT NULL,kind text NOT NULL CHECK(kind IN('ciam','llm','ocr')),
  region text NOT NULL CHECK(region IN('cn-beijing','cn-mainland','cn-shanghai')),allowed_origins text[] NOT NULL CHECK(cardinality(allowed_origins)>0),
  allowed_data_categories text[] NOT NULL CHECK(allowed_data_categories<@ARRAY['authentication_assertion','confirmed_structured_learning_data','minimal_crop','source_image']::text[]),
  contract jsonb NOT NULL CHECK(
    jsonb_typeof(contract)='object'
    AND contract ?& ARRAY['dataRegionSigned','deletionSlaSigned','incidentNoticeSigned','noTrainingSigned','retentionSigned','subprocessorsSigned','supportAccessSigned','exitMigrationSigned']
    AND contract - ARRAY['dataRegionSigned','deletionSlaSigned','incidentNoticeSigned','noTrainingSigned','retentionSigned','subprocessorsSigned','supportAccessSigned','exitMigrationSigned']::text[] = '{}'::jsonb
    AND jsonb_typeof(contract->'dataRegionSigned')='boolean'
    AND jsonb_typeof(contract->'deletionSlaSigned')='boolean'
    AND jsonb_typeof(contract->'incidentNoticeSigned')='boolean'
    AND jsonb_typeof(contract->'noTrainingSigned')='boolean'
    AND jsonb_typeof(contract->'retentionSigned')='boolean'
    AND jsonb_typeof(contract->'subprocessorsSigned')='boolean'
    AND jsonb_typeof(contract->'supportAccessSigned')='boolean'
    AND jsonb_typeof(contract->'exitMigrationSigned')='boolean'
  ),enabled boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL,
  CHECK(kind<>'ocr' OR region='cn-shanghai')
);
CREATE TABLE metrics.provider_egress_audit(
  request_id uuid PRIMARY KEY,capability_version_id text NOT NULL,provider_id text,purpose text NOT NULL,
  region text CHECK(region IS NULL OR region IN('cn-beijing','cn-mainland','cn-shanghai')),
  destination_origin text NOT NULL,data_categories text[] NOT NULL,payload_hash text NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'),
  response_hash text CHECK(response_hash IS NULL OR response_hash~'^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK(outcome IN('blocked','failed','succeeded','timed_out')),finished_at timestamptz NOT NULL
);
DO $$BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rhea_provider_gateway')THEN CREATE ROLE rhea_provider_gateway NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rhea_provider_governance_admin')THEN CREATE ROLE rhea_provider_governance_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;END IF;
END$$;
ALTER ROLE rhea_provider_gateway SET search_path=pg_catalog,metrics;
ALTER ROLE rhea_provider_governance_admin SET search_path=pg_catalog,metrics;
GRANT USAGE ON SCHEMA metrics TO rhea_provider_gateway,rhea_provider_governance_admin;
ALTER TABLE metrics.provider_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.provider_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE metrics.provider_egress_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.provider_egress_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_capabilities_gateway ON metrics.provider_capabilities
  USING(current_user IN('rhea_provider_gateway','rhea_provider_governance_admin'))
  WITH CHECK(current_user='rhea_provider_governance_admin');
CREATE POLICY provider_egress_audit_gateway ON metrics.provider_egress_audit
  USING(current_user='rhea_provider_gateway') WITH CHECK(current_user='rhea_provider_gateway');
GRANT SELECT ON metrics.provider_capabilities TO rhea_provider_gateway;
GRANT SELECT,INSERT ON metrics.provider_capabilities TO rhea_provider_governance_admin;
GRANT INSERT ON metrics.provider_egress_audit TO rhea_provider_gateway;
REVOKE ALL ON SCHEMA learning,safety FROM rhea_provider_gateway;
REVOKE ALL ON SCHEMA learning,safety FROM rhea_provider_governance_admin;

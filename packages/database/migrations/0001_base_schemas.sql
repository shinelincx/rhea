CREATE SCHEMA IF NOT EXISTS learning;
CREATE SCHEMA IF NOT EXISTS safety;
CREATE SCHEMA IF NOT EXISTS metrics;

CREATE TABLE IF NOT EXISTS learning.async_job_observations (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

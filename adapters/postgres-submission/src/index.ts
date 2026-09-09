import { createHash } from 'node:crypto';

import type {
  ConfirmedContent,
  ProcessingJob,
  RawAssetDeletionPort,
  RawAssetDeletionReceipt,
  RecognitionCandidate,
  SubmissionStore,
  UploadPage,
  UploadSession,
} from '@rhea/submission';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

interface UploadRow extends QueryResultRow {
  created_at: Date;
  expires_at: Date;
  family_space_id: string;
  id: string;
  job_id: string | null;
  learning_profile_id: string;
  status: UploadSession['status'];
}

interface PageRow extends QueryResultRow {
  crop: UploadPage['crop'];
  declared_mime_type: string;
  file_name: string;
  height: number | null;
  id: string;
  object_key: string;
  observed_mime_type: string | null;
  page_order: number;
  rotation: UploadPage['rotation'];
  sha256: string;
  size_bytes: number;
  upload_token_hash: string;
  uploaded_at: Date | null;
  width: number | null;
}

interface JobRow extends QueryResultRow {
  cancellation_version: number;
  created_at: Date;
  error_code: ProcessingJob['errorCode'];
  family_space_id: string;
  id: string;
  learning_profile_id: string;
  quality_issues: ProcessingJob['qualityIssues'];
  revision: number;
  status: ProcessingJob['status'];
  updated_at: Date;
  upload_session_id: string;
}

async function setProfile(client: PoolClient, learningProfileId: string): Promise<void> {
  await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
    learningProfileId,
  ]);
}

function uploadPage(row: PageRow): UploadPage {
  return {
    crop: row.crop,
    fileName: row.file_name,
    height: row.height,
    id: row.id,
    mimeType: row.declared_mime_type,
    objectKey: row.object_key,
    observedMimeType: row.observed_mime_type,
    order: row.page_order,
    rotation: row.rotation,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at?.toISOString() ?? null,
    width: row.width,
  };
}

export class PostgresSubmissionStore implements SubmissionStore, RawAssetDeletionPort {
  constructor(private readonly pool: Pool) {}

  async createUploadSession(session: UploadSession): Promise<void> {
    await this.#withProfile(session.learningProfileId, async (client) => {
      await client.query(
        `INSERT INTO learning.upload_sessions
          (id, family_space_id, learning_profile_id, status, job_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.id,
          session.familySpaceId,
          session.learningProfileId,
          session.status,
          session.jobId,
          session.createdAt,
          session.expiresAt,
        ],
      );
      for (const page of session.pages) {
        await client.query(
          `INSERT INTO learning.upload_pages
            (id, upload_session_id, learning_profile_id, file_name, declared_mime_type,
             observed_mime_type, size_bytes, sha256, page_order, rotation, crop,
             width, height, object_key, upload_token_hash, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            page.id,
            session.id,
            session.learningProfileId,
            page.fileName,
            page.mimeType,
            page.observedMimeType,
            page.sizeBytes,
            page.sha256,
            page.order,
            page.rotation,
            page.crop,
            page.width,
            page.height,
            page.objectKey,
            session.uploadTokenHashes[page.id],
            page.uploadedAt,
          ],
        );
      }
    });
  }

  async findUploadSession(id: string, learningProfileId?: string): Promise<UploadSession | null> {
    if (!learningProfileId) {
      return null;
    }
    return this.#withProfile(learningProfileId, async (client) => {
      const upload = await client.query<UploadRow>(
        `SELECT id, family_space_id, learning_profile_id, status, job_id, created_at, expires_at
         FROM learning.upload_sessions WHERE id = $1 AND learning_profile_id = $2`,
        [id, learningProfileId],
      );
      const row = upload.rows[0];
      if (!row) {
        return null;
      }
      const pages = await client.query<PageRow>(
        `SELECT id, file_name, declared_mime_type, observed_mime_type, size_bytes,
                sha256, page_order, rotation, crop, width, height, object_key,
                upload_token_hash, uploaded_at
         FROM learning.upload_pages WHERE upload_session_id = $1 ORDER BY page_order`,
        [id],
      );
      return {
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        familySpaceId: row.family_space_id,
        id: row.id,
        jobId: row.job_id,
        learningProfileId: row.learning_profile_id,
        pages: pages.rows.map(uploadPage),
        status: row.status,
        uploadTokenHashes: Object.fromEntries(
          pages.rows.map((page) => [page.id, page.upload_token_hash]),
        ),
      };
    });
  }

  async saveUploadSession(session: UploadSession): Promise<void> {
    await this.#withProfile(session.learningProfileId, async (client) => {
      await client.query(
        `UPDATE learning.upload_sessions SET status = $2, job_id = $3
         WHERE id = $1 AND learning_profile_id = $4`,
        [session.id, session.status, session.jobId, session.learningProfileId],
      );
      for (const page of session.pages) {
        await client.query(
          `UPDATE learning.upload_pages
           SET observed_mime_type = $3, uploaded_at = $4
           WHERE id = $1 AND upload_session_id = $2`,
          [page.id, session.id, page.observedMimeType, page.uploadedAt],
        );
      }
    });
  }

  async createJob(job: ProcessingJob): Promise<ProcessingJob> {
    return this.#withProfile(job.learningProfileId, async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM learning.processing_jobs WHERE upload_session_id = $1',
        [job.uploadSessionId],
      );
      if (existing.rows[0]) {
        return (await this.#findJob(client, existing.rows[0].id, job.learningProfileId))!;
      }
      await client.query(
        `INSERT INTO learning.processing_jobs
          (id, upload_session_id, family_space_id, learning_profile_id, status,
           error_code, quality_issues, cancellation_version, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          job.id,
          job.uploadSessionId,
          job.familySpaceId,
          job.learningProfileId,
          job.status,
          job.errorCode,
          JSON.stringify(job.qualityIssues),
          job.cancellationVersion,
          job.revision,
          job.createdAt,
          job.updatedAt,
        ],
      );
      await client.query(
        `UPDATE learning.upload_sessions SET status = 'submitted', job_id = $2 WHERE id = $1`,
        [job.uploadSessionId, job.id],
      );
      return job;
    });
  }

  async findJob(id: string, learningProfileId: string): Promise<ProcessingJob | null> {
    return this.#withProfile(learningProfileId, (client) =>
      this.#findJob(client, id, learningProfileId),
    );
  }

  async saveJobIfRevision(job: ProcessingJob, expectedRevision: number): Promise<boolean> {
    return this.#withProfile(job.learningProfileId, async (client) => {
      const updated = await client.query(
        `UPDATE learning.processing_jobs SET
           status = $3, error_code = $4, quality_issues = $5,
           cancellation_version = $6, revision = $7, updated_at = $8
         WHERE id = $1 AND learning_profile_id = $2 AND revision = $9`,
        [
          job.id,
          job.learningProfileId,
          job.status,
          job.errorCode,
          JSON.stringify(job.qualityIssues),
          job.cancellationVersion,
          job.revision,
          job.updatedAt,
          expectedRevision,
        ],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      if (job.candidate) {
        await this.#insertCandidate(client, job, job.candidate);
      }
      if (job.completedContent) {
        await this.#insertConfirmedContent(client, job, job.completedContent);
      }
      return true;
    });
  }

  async record(receipt: RawAssetDeletionReceipt): Promise<void> {
    await this.#withProfile(receipt.learningProfileId, async (client) => {
      await client.query(
        `INSERT INTO learning.raw_asset_deletions
          (learning_profile_id, object_key_hash, deletion_proof)
         VALUES ($1, $2, $3)
         ON CONFLICT (learning_profile_id, object_key_hash) DO NOTHING`,
        [
          receipt.learningProfileId,
          createHash('sha256').update(receipt.objectKey).digest('hex'),
          receipt.proof,
        ],
      );
    });
  }

  async #findJob(
    client: PoolClient,
    id: string,
    learningProfileId: string,
  ): Promise<ProcessingJob | null> {
    const result = await client.query<JobRow>(
      `SELECT id, upload_session_id, family_space_id, learning_profile_id, status,
              error_code, quality_issues, cancellation_version, revision, created_at, updated_at
       FROM learning.processing_jobs WHERE id = $1 AND learning_profile_id = $2`,
      [id, learningProfileId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const candidates = await client.query<
      QueryResultRow & {
        adapter_version: string;
        id: string;
        regions: RecognitionCandidate['regions'];
        source_hash: string;
      }
    >(
      `SELECT id, adapter_version, source_hash, regions
       FROM learning.recognition_candidates WHERE job_id = $1`,
      [id],
    );
    const confirmed = await client.query<
      QueryResultRow & {
        confirmed_at: Date;
        confirmed_by_learning_profile_id: string;
        id: string;
        regions: ConfirmedContent['regions'];
        source_candidate_id: string;
        source_hash: string;
        version: number;
      }
    >(
      `SELECT id, version, source_candidate_id, source_hash, regions,
              confirmed_by_learning_profile_id, confirmed_at
       FROM learning.confirmed_content_versions WHERE job_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    const candidate = candidates.rows[0];
    const content = confirmed.rows[0];
    return {
      candidate: candidate
        ? {
            adapterVersion: candidate.adapter_version,
            id: candidate.id,
            regions: candidate.regions,
            sourceHash: candidate.source_hash,
          }
        : null,
      cancellationVersion: row.cancellation_version,
      completedContent: content
        ? {
            confirmedAt: content.confirmed_at.toISOString(),
            confirmedByLearningProfileId: content.confirmed_by_learning_profile_id,
            id: content.id,
            regions: content.regions,
            sourceCandidateId: content.source_candidate_id,
            sourceHash: content.source_hash,
            version: content.version,
          }
        : null,
      createdAt: row.created_at.toISOString(),
      errorCode: row.error_code,
      familySpaceId: row.family_space_id,
      id: row.id,
      learningProfileId: row.learning_profile_id,
      qualityIssues: row.quality_issues,
      revision: row.revision,
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
      uploadSessionId: row.upload_session_id,
    };
  }

  async #insertCandidate(
    client: PoolClient,
    job: ProcessingJob,
    candidate: RecognitionCandidate,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.recognition_candidates
        (id, job_id, learning_profile_id, adapter_version, source_hash, regions)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        candidate.id,
        job.id,
        job.learningProfileId,
        candidate.adapterVersion,
        candidate.sourceHash,
        JSON.stringify(candidate.regions),
      ],
    );
  }

  async #insertConfirmedContent(
    client: PoolClient,
    job: ProcessingJob,
    content: ConfirmedContent,
  ): Promise<void> {
    await client.query(
      `INSERT INTO learning.confirmed_content_versions
        (id, job_id, learning_profile_id, version, source_candidate_id, source_hash,
         regions, confirmed_by_learning_profile_id, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_id, version) DO NOTHING`,
      [
        content.id,
        job.id,
        job.learningProfileId,
        content.version,
        content.sourceCandidateId,
        content.sourceHash,
        JSON.stringify(content.regions),
        content.confirmedByLearningProfileId,
        content.confirmedAt,
      ],
    );
  }

  async #withProfile<Result>(
    learningProfileId: string,
    action: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setProfile(client, learningProfileId);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresSubmissionStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresSubmissionStore(pool);
  return { pool, store };
}

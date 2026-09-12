import { describe, expect, it } from 'vitest';

import rubricCatalog from '../../../modules/assessment/assets/open-assessment-rubrics.v2.json' with { type: 'json' };

import {
  applyMigrations,
  loadDefaultMigrations,
  type DatabaseClient,
  type Migration,
} from '../src/index.js';

class RecordingDatabase implements DatabaseClient {
  readonly applied = new Set<string>();
  readonly executedMigrationSql: string[] = [];
  readonly transactions: string[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    const normalized = sql.trim().toUpperCase();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.transactions.push(normalized);
    } else if (normalized.startsWith('SELECT VERSION')) {
      return {
        rows: [...this.applied].map((version) => ({ version })) as unknown as Row[],
      };
    } else if (normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) {
      return { rows: [] };
    } else if (normalized.startsWith('INSERT INTO PUBLIC.RHEA_SCHEMA_MIGRATIONS')) {
      this.applied.add(String(values[0]));
    } else if (!normalized.startsWith('CREATE TABLE IF NOT EXISTS PUBLIC.RHEA_SCHEMA_MIGRATIONS')) {
      this.executedMigrationSql.push(sql);
    }

    return { rows: [] };
  }
}

describe('database migration interface', () => {
  it('keeps the immutable SQL rubric seed synchronized with the shared reviewed catalog', async () => {
    const migration = (await loadDefaultMigrations()).find(({ version }) => version === '0017');
    const seededDimensions = [
      ...(migration?.sql.matchAll(/'(\[\s*\{[\s\S]*?\}\s*\])'::jsonb/g) ?? []),
    ]
      .slice(0, 4)
      .map((match) => JSON.parse(match[1]!));

    expect(seededDimensions).toEqual(
      Object.values(rubricCatalog.templates).map(({ dimensions }) => dimensions),
    );
    expect(migration?.sql).toContain(`'${rubricCatalog.version}'`);
    expect(migration?.sql).toContain(`'${rubricCatalog.sourceLabel}'`);
  });

  it('applies an ordered migration once and safely skips it on a repeat run', async () => {
    const database = new RecordingDatabase();
    const migrations: Migration[] = [
      {
        name: 'base schemas',
        sql: 'CREATE SCHEMA IF NOT EXISTS learning;',
        version: '0001',
      },
    ];

    const first = await applyMigrations(database, migrations);
    const second = await applyMigrations(database, migrations);

    expect(first).toEqual({ applied: ['0001'], skipped: [] });
    expect(second).toEqual({ applied: [], skipped: ['0001'] });
    expect(database.executedMigrationSql).toEqual(['CREATE SCHEMA IF NOT EXISTS learning;']);
    expect(database.transactions).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });

  it('ships an initial migration that owns the three approved data schemas', async () => {
    const migrations = await loadDefaultMigrations();

    expect(migrations.map(({ version }) => version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017',
      '0018',
      '0019',
      '0020',
    ]);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS learning/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS safety/i);
    expect(migrations[0]?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS metrics/i);
    expect(migrations[3]?.sql).toMatch(/CREATE TABLE learning\.processing_jobs/i);
    expect(migrations[3]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[7]?.sql).toMatch(/CREATE TABLE learning\.objective_assessments/i);
    expect(migrations[7]?.sql).toMatch(/CREATE TABLE learning\.objective_grading_rule_versions/i);
    expect(migrations[7]?.sql).toMatch(/CREATE ROLE rhea_assessment_app/i);
    expect(migrations[3]?.sql).not.toMatch(
      /FUNCTION learning\.resolve_confirmed_objective_regions/i,
    );
    expect(migrations[4]?.sql).not.toMatch(
      /FUNCTION learning\.resolve_objective_assessment_basis/i,
    );
    expect(migrations[5]?.sql).toMatch(/FUNCTION learning\.resolve_confirmed_objective_regions/i);
    expect(migrations[5]?.sql).toMatch(/questionRegionId/i);
    expect(migrations[6]?.sql).toMatch(/FUNCTION learning\.resolve_objective_assessment_basis/i);
    expect(migrations[6]?.sql).toMatch(/FUNCTION learning\.lock_current_assessment_basis/i);
    expect(migrations[6]?.sql).toMatch(/SECURITY DEFINER/i);
    expect(migrations[6]?.sql).toMatch(
      /REVOKE ALL ON FUNCTION learning\.lock_current_assessment_basis/i,
    );
    expect(migrations[7]?.sql).toMatch(/FUNCTION learning\.resolve_objective_assessment_input/i);
    expect(migrations[7]?.sql).toMatch(/FUNCTION learning\.confirm_objective_grading_rule/i);
    expect(migrations[7]?.sql).toMatch(
      /REVOKE ALL ON FUNCTION learning\.confirm_objective_grading_rule/i,
    );
    expect(migrations[7]?.sql).toMatch(/input_authority jsonb NOT NULL/i);
    expect(migrations[7]?.sql).toMatch(/resolved_by_type IN \('guardian', 'professional'\)/i);
    expect(migrations[7]?.sql).toMatch(/SET search_path = pg_catalog, learning/i);
    expect(migrations[7]?.sql).not.toMatch(
      /(?:FROM|JOIN) learning\.(?:confirmed_content_versions|classification_versions|basis_selection_versions|learning_source_versions)/i,
    );
    expect(migrations[7]?.sql).toMatch(
      /ALTER TABLE learning\.objective_grading_rule_versions FORCE ROW LEVEL SECURITY/i,
    );
    expect(migrations[8]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_eligibility/i,
    );
    expect(migrations[9]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_content/i,
    );
    expect(migrations[10]?.sql).toMatch(
      /FUNCTION learning\.lock_current_generated_learning_basis/i,
    );
    expect(migrations[11]?.sql).toMatch(/CREATE ROLE rhea_generated_learning_app/i);
    expect(migrations[11]?.sql).toMatch(/FUNCTION learning\.lock_generated_learning_publication/i);
    expect(migrations[12]?.sql).toMatch(/CREATE TABLE metrics\.capability_versions/i);
    expect(migrations[12]?.sql).toMatch(/CREATE TABLE metrics\.quality_card_revisions/i);
    expect(migrations[12]?.sql).toMatch(/CREATE TABLE metrics\.capability_release_revisions/i);
    expect(migrations[12]?.sql).toMatch(/CREATE TABLE metrics\.shadow_observations/i);
    expect(migrations[12]?.sql).toMatch(/CREATE ROLE rhea_quality_runtime/i);
    expect(migrations[12]?.sql).toMatch(/CREATE ROLE rhea_quality_governance/i);
    expect(migrations[12]?.sql).toMatch(/FUNCTION metrics\.authorize_capability/i);
    expect(migrations[12]?.sql).toMatch(/FUNCTION metrics\.contain_capability/i);
    expect(migrations[12]?.sql).toMatch(
      /family_space_hash text NOT NULL CHECK \(family_space_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i,
    );
    expect(migrations[12]?.sql).toMatch(
      /FUNCTION metrics\.save_quality_authorization_decision[\s\S]*p_guard ->> 'familySpaceHash'/i,
    );
    expect(migrations[12]?.sql).toMatch(
      /UNIQUE \(id, primary_version_id, containment_epoch, family_space_hash\)/i,
    );
    expect(migrations[12]?.sql).toMatch(
      /FUNCTION metrics\.lock_current_family_capability_authorization\(\s*p_authorization_id text,\s*p_capability_version_id text,\s*p_expected_containment_epoch bigint,\s*p_family_space_hash text,\s*p_phase text,\s*p_route text/i,
    );
    expect(migrations[12]?.sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION metrics\.lock_current_capability_authorization\(\s*text, text, bigint, text, text\s*\) FROM rhea_learning_app/i,
    );
    expect(migrations[12]?.sql).toMatch(/SET search_path = pg_catalog, metrics/i);
    expect(migrations[12]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[13]?.sql).toMatch(/ADD COLUMN capability_version_id text NOT NULL/i);
    expect(migrations[13]?.sql).toMatch(/recognition_candidates_capability_fk/i);
    expect(migrations[13]?.sql).toMatch(/recognition_candidates_authorization_fk/i);
    expect(migrations[14]?.sql).toMatch(/authorization_snapshot jsonb/i);
    expect(migrations[14]?.sql).toMatch(
      /generated_learning_request_primary_capability_fk[\s\S]*FOREIGN KEY \([\s\S]*authorization_decision_id,[\s\S]*capability_version_id,[\s\S]*authorization_containment_epoch[\s\S]*REFERENCES metrics\.authorization_decisions\([\s\S]*id, primary_version_id, containment_epoch/i,
    );
    expect(migrations[14]?.sql).toMatch(
      /generated_learning_content_primary_capability_fk[\s\S]*FOREIGN KEY \([\s\S]*authorization_decision_id,[\s\S]*capability_version_id,[\s\S]*authorization_containment_epoch[\s\S]*REFERENCES metrics\.authorization_decisions\([\s\S]*id, primary_version_id, containment_epoch/i,
    );
    expect(migrations[14]?.sql).toMatch(
      /CREATE FUNCTION learning\.complete_generated_learning_request[\s\S]*?metrics\.lock_current_family_capability_authorization\([\s\S]*?'before_publish',[\s\S]*?'primary'[\s\S]*?REVOKE ALL ON FUNCTION learning\.complete_generated_learning_request/i,
    );
    expect(migrations[14]?.sql).toMatch(
      /CREATE OR REPLACE FUNCTION learning\.reveal_generated_learning_hint[\s\S]*?metrics\.lock_current_family_capability_authorization\([\s\S]*?'before_publish',[\s\S]*?'primary'[\s\S]*?REVOKE ALL ON FUNCTION learning\.reveal_generated_learning_hint/i,
    );
    expect(migrations[15]?.sql).toMatch(/CREATE TABLE learning\.source_revisions/i);
    expect(migrations[15]?.sql).toMatch(/CREATE TABLE learning\.derivation_edges/i);
    expect(migrations[15]?.sql).toMatch(/CREATE TABLE learning\.rebuild_jobs/i);
    expect(migrations[15]?.sql).toMatch(/FUNCTION learning\.record_source_revision/i);
    expect(migrations[15]?.sql).toMatch(/FUNCTION learning\.publish_derived_artifact/i);
    expect(migrations[15]?.sql).toMatch(/FUNCTION learning\.claim_lineage_rebuild/i);
    expect(migrations[15]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[15]?.sql).toMatch(/CREATE ROLE rhea_lineage_runtime/i);
    expect(migrations[16]?.sql).toMatch(/CREATE TABLE learning\.open_assessment_rubric_versions/i);
    expect(migrations[16]?.sql).toMatch(/CREATE TABLE learning\.suggested_assessments/i);
    expect(migrations[16]?.sql).toMatch(/FUNCTION learning\.resolve_open_assessment_input/i);
    expect(migrations[16]?.sql).toMatch(
      /FUNCTION learning\.create_suggested_assessment[\s\S]*v_status NOT IN \('queued', 'unavailable'\)/i,
    );
    expect(migrations[16]?.sql).toMatch(/FUNCTION learning\.mark_suggested_assessment_generating/i);
    expect(migrations[16]?.sql).toMatch(
      /FUNCTION learning\.complete_suggested_assessment_generation[\s\S]*'after_receive'/i,
    );
    expect(migrations[16]?.sql).toMatch(
      /FUNCTION learning\.review_suggested_assessment[\s\S]*metrics\.lock_current_family_capability_authorization/i,
    );
    expect(migrations[16]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[17]?.sql).toMatch(/CREATE TABLE learning\.wrong_items/i);
    expect(migrations[17]?.sql).toMatch(/FUNCTION learning\.create_wrong_item/i);
    expect(migrations[17]?.sql).toMatch(/CREATE ROLE rhea_learning_progress_app/i);
    expect(migrations[17]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migrations[17]?.sql).toMatch(
      /REVOKE ALL ON FUNCTION learning\.create_wrong_item\(jsonb\) FROM PUBLIC/i,
    );
    expect(migrations[19]?.sql).toMatch(/CREATE TABLE learning\.wrong_item_theme_mastery/i);
    expect(migrations[19]?.sql).toMatch(/CREATE TABLE learning\.learning_evidence/i);
    expect(migrations[19]?.sql).toMatch(/CREATE TABLE learning\.theme_mastery_transitions/i);
    expect(migrations[19]?.sql).toMatch(/FUNCTION learning\.record_learning_evidence/i);
    expect(migrations[19]?.sql).toMatch(/AT TIME ZONE 'Asia\/Shanghai'/i);
    expect(migrations[19]?.sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it('upgrades a database recorded at 0005 without rewriting released migrations', async () => {
    const database = new RecordingDatabase();
    for (const version of ['0001', '0002', '0003', '0004', '0005']) {
      database.applied.add(version);
    }

    const result = await applyMigrations(database, await loadDefaultMigrations());

    expect(result).toEqual({
      applied: [
        '0006',
        '0007',
        '0008',
        '0009',
        '0010',
        '0011',
        '0012',
        '0013',
        '0014',
        '0015',
        '0016',
        '0017',
        '0018',
        '0019',
        '0020',
      ],
      skipped: ['0001', '0002', '0003', '0004', '0005'],
    });
    expect(database.executedMigrationSql).toHaveLength(15);
  });
});

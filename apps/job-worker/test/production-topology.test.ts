import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');

describe('Shanghai single-active production topology', () => {
  it('declares one active application node with separate API and worker processes', async () => {
    const [compose, dockerfile, terraform, runtimeVerifier] = await Promise.all([
      read('infra/production/compose.yaml'),
      read('Dockerfile'),
      read('infra/production/terraform/main.tf'),
      read('infra/production/operations/verify-runtime-entrypoints.mjs'),
    ]);
    expect(terraform.match(/resource\s+"alicloud_instance"\s+"active"/g)).toHaveLength(1);
    expect(terraform).toContain('RegionBoundary = "Shanghai"');
    expect(compose).toContain('  api:');
    expect(compose).toContain('  credential-broker:');
    expect(compose).toContain('  worker-ai:');
    expect(compose).toContain('  worker-domain:');
    expect(compose).toContain('  worker-safety:');
    expect(compose).toContain("command: ['node', 'apps/app-api/dist/main.js']");
    expect(compose).toContain("command: ['node', 'apps/job-worker/dist/main.js', 'ai']");
    expect(compose).toContain('env_file: /etc/rhea/api.env');
    expect(compose).toContain('env_file: /etc/rhea/ai-worker.env');
    expect(compose).toContain('env_file: /etc/rhea/domain-worker.env');
    expect(compose).toContain('env_file: /etc/rhea/safety-worker.env');
    expect(compose).toContain('env_file: /etc/rhea/credential-broker.env');
    expect(compose).toContain('credentials-api:/run/rhea-credentials:ro');
    expect(compose).toContain('credentials-ai:/run/rhea-credentials:ro');
    expect(compose).toContain('credentials-safety:/run/rhea-credentials:ro');
    expect(dockerfile).toMatch(/CMD\s+\["node",\s*"apps\/app-api\/dist\/main\.js"\]/);
    expect(dockerfile).toContain('NODE_OPTIONS=--conditions=production');
    expect(runtimeVerifier).toContain("'apps/app-api/dist/main.js'");
    expect(runtimeVerifier).toContain("'apps/job-worker/dist/main.js'");
    expect(runtimeVerifier).toContain("'apps/credential-broker/dist/main.js'");
    expect(compose).not.toContain('dist/src/main.js');
    expect(dockerfile).not.toContain('dist/src/main.js');
    expect(compose).not.toMatch(/^\s{2}(postgres|redis|minio):/m);
  });

  it('uses managed PostgreSQL, Tair, private OSS and KMS with a narrow network boundary', async () => {
    const terraform = await read('infra/production/terraform/main.tf');
    expect(terraform).toContain('resource "alicloud_db_instance" "postgres"');
    expect(terraform).toContain('resource "alicloud_kvstore_instance" "redis"');
    expect(terraform).toContain('resource "alicloud_oss_bucket" "private"');
    expect(terraform).toContain('resource "alicloud_oss_bucket" "erasure_ledger"');
    expect(terraform).toContain('resource "alicloud_kms_key" "learning"');
    expect(terraform).toContain('resource "alicloud_kms_key" "safety"');
    expect(terraform).toMatch(/system_disk_encrypted\s+= true/);
    expect(terraform).toMatch(/system_disk_kms_key_id\s+= alicloud_kms_key\.learning\.id/);
    expect(terraform).toContain('encryption_key           = alicloud_kms_key.learning.id');
    expect(terraform).toContain('ssl_action               = "Open"');
    expect(terraform).toMatch(/tde_status\s+= "Enabled"/);
    expect(terraform).toMatch(/ssl_enable\s+= "Enable"/);
    expect(terraform.match(/sse_algorithm\s+= "KMS"/g)).toHaveLength(2);
    expect(terraform).toContain('kms_master_key_id = alicloud_kms_key.safety.id');
    expect(terraform).toContain('noncurrent_version_expiration { days = 30 }');
    expect(terraform).toContain('prevent_destroy = true');
    for (const account of [
      'api',
      'ai_worker',
      'domain_worker',
      'safety_worker',
      'recovery',
      'provider_governance',
      'support',
      'operations',
    ]) {
      expect(terraform).toContain(`resource "alicloud_rds_account" "${account}"`);
    }
    expect(terraform).toContain('resource "alicloud_ram_role" "credential_broker"');
    expect(terraform).toContain('resource "alicloud_ram_role" "object_storage_api"');
    expect(terraform).toContain('resource "alicloud_ram_role" "object_storage_ai"');
    expect(terraform).toContain('resource "alicloud_ram_role" "object_storage_privacy"');
    expect(terraform).toContain('"sts:AssumeRole"');
    expect(terraform).toContain('resource "alicloud_ram_policy" "object_storage_api"');
    expect(terraform).toContain('resource "alicloud_ram_policy" "object_storage_ai"');
    const privacyObjectPolicy = terraform.match(
      /resource "alicloud_ram_policy" "object_storage_privacy" \{([\s\S]*?)resource "alicloud_ram_role_policy_attachment"/,
    )?.[1];
    expect(privacyObjectPolicy).toContain('"oss:DeleteObjectVersion"');
    expect(privacyObjectPolicy).not.toContain('"oss:PutObject"');
    expect(terraform).toContain('"kms:Encrypt"');
    expect(terraform).toContain('"kms:Decrypt"');
    const brokerPolicy = terraform.match(
      /resource "alicloud_ram_policy" "credential_broker_assume" \{([\s\S]*?)resource "alicloud_ram_role_policy_attachment"/,
    )?.[1];
    expect(brokerPolicy).toContain('"sts:AssumeRole"');
    expect(brokerPolicy).not.toContain('kms:');
    for (const policyName of ['object_storage_api', 'object_storage_ai']) {
      const workloadPolicy = terraform.match(
        new RegExp(
          'resource "alicloud_ram_policy" "' +
            policyName +
            '" \\{([\\s\\S]*?)resource "alicloud_ram_(?:role_)?policy_attachment"',
        ),
      )?.[1];
      expect(workloadPolicy).toContain('"kms:GenerateDataKey"');
      expect(workloadPolicy).toContain('"kms:Decrypt"');
      expect(workloadPolicy).toContain('alicloud_kms_key.learning.id');
      expect(workloadPolicy).toContain('alicloud_kms_key.safety.id');
    }
    expect(terraform).toContain('resource "alicloud_oss_bucket_worm" "erasure_ledger"');
    expect(terraform).toContain('retention_period_in_days = 3650');
    expect(terraform).toContain('resource "alicloud_ram_user" "erasure_ledger_writer"');
    expect(terraform).toContain('resource "alicloud_ram_user" "erasure_ledger_reader"');
    expect(terraform).toContain('"kms:GenerateDataKey"');
    expect(terraform.match(/alicloud_kms_key\.safety\.id/g)?.length).toBeGreaterThanOrEqual(3);
    expect(terraform).toContain('internet_max_bandwidth_out = 0');
    expect(terraform.match(/nic_type\s+= "intranet"/g)).toHaveLength(2);
    expect(terraform).toMatch(/security_ips\s+= \["10\.30\.1\.0\/24"\]/);
  });

  it('keeps recovery evidence for RPO, RTO, key/tombstone checks and quarterly recurrence', async () => {
    const [drill, rebuild] = await Promise.all([
      read('infra/production/operations/recovery-drill.mjs'),
      read('apps/job-worker/src/rebuild-runtime.ts'),
    ]);
    expect(drill).toContain("check: 'rpo_within_15_minutes'");
    expect(drill).toContain("check: 'rto_within_4_hours'");
    expect(drill).toContain("check: 'erasure_tombstones_replayed'");
    expect(drill).toContain('ERASURE_LEDGER_BUCKET');
    expect(drill).toContain("'erasure-ledger/'");
    expect(drill).toContain("check: 'key_management_decrypt_probe'");
    expect(drill).toContain("check: 'redis_authority_rebuilt'");
    expect(drill).toContain('nextRequiredBy');
    expect(rebuild).toContain('learning.read_runtime_rebuild_snapshot()');
  });

  it('keeps operations off public HTTPS and exposes the API only on host loopback', async () => {
    const [compose, nginx, operations] = await Promise.all([
      read('infra/production/compose.yaml'),
      read('infra/production/nginx.conf'),
      read('infra/production/operations/README.md'),
    ]);
    expect(compose).toContain("ports: ['127.0.0.1:3000:3000']");
    expect(nginx).toMatch(/location \^~ \/internal\/operations\/\s*\{\s*return 404;/m);
    expect(operations).toContain('SSH security-group');
    expect(operations).toContain('OPERATIONS_PRINCIPAL_ROLES');
    expect(operations).toContain('challenge_report_classification_failed');
    expect(operations).toContain('The domain worker does not');
    expect(operations).toContain('CREDENTIAL_BROKER_API_ROLE_ARN');
    expect(operations).toContain('short-lived STS credential files');
    expect(operations).toContain('ordinary containers cannot reach IMDS');
    expect(compose).toContain("profiles: ['operations']");
    expect(compose).toContain("apps/credential-broker/dist/main.js', 'smoke'");
    expect(operations).toContain('SSE-KMS put/get');
  });

  it('loads a validated default-deny firewall before Docker can start the stack', async () => {
    const [compose, firewall, firewallUnit, stackUnit] = await Promise.all([
      read('infra/production/compose.yaml'),
      read('infra/production/operations/apply-egress-firewall.sh'),
      read('infra/production/systemd/rhea-egress-firewall.service'),
      read('infra/production/systemd/rhea-stack.service'),
    ]);
    expect(firewall).toContain('nft -c -f "$replacement_file"');
    expect(firewall).toMatch(/delete table inet rhea_egress[\s\S]+render_rules rhea_egress/);
    expect(firewall).not.toMatch(/^nft delete table/m);
    expect(firewall).toContain('ip saddr 172.30.0.2 ip daddr 100.100.100.200');
    expect(firewall).toContain('ip daddr 100.100.100.200 drop');
    expect(firewallUnit).toContain('Before=network.target docker.service rhea-stack.service');
    expect(firewallUnit).toContain('RequiredBy=docker.service');
    expect(stackUnit).toContain('Requires=docker.service rhea-egress-firewall.service');
    expect(compose).not.toContain('restart: always');
    expect(compose).toContain("restart: 'on-failure:5'");
    expect(compose.match(/cap_drop: \['ALL'\]/g)).toHaveLength(8);
    expect(compose).toContain("cap_add: ['CHOWN']");
  });
});

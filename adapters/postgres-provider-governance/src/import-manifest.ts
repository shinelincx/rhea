import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import {
  assertProviderCapability,
  MemoryProviderGovernanceStore,
  providerCapabilitiesEqual,
  ProviderGovernanceService,
  type ProviderCapability,
} from '@rhea/provider-governance';

import { createPostgresProviderGovernanceStore } from './index.js';

interface SignedManifest {
  approvedAt: string;
  approvedBy: string;
  capabilities: ProviderCapability[];
  schemaVersion: 1;
  signature: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertProductionDatabaseTransport(name: string, value: string): void {
  if (process.env.NODE_ENV !== 'production') return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.searchParams.get('sslmode') !== 'verify-full'
  ) {
    throw new Error(`${name} must use PostgreSQL sslmode=verify-full in production`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseManifest(value: unknown): SignedManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('PROVIDER_MANIFEST_INVALID');
  const manifest = value as Partial<SignedManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.approvedAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.approvedAt)) ||
    typeof manifest.approvedBy !== 'string' ||
    !manifest.approvedBy.trim() ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length === 0 ||
    typeof manifest.signature !== 'string'
  )
    throw new Error('PROVIDER_MANIFEST_INVALID');
  for (const capability of manifest.capabilities) assertProviderCapability(capability);
  return manifest as SignedManifest;
}

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: pnpm import-manifest <signed-manifest.json>');
const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
const signedPayload = {
  approvedAt: manifest.approvedAt,
  approvedBy: manifest.approvedBy,
  capabilities: manifest.capabilities,
  schemaVersion: manifest.schemaVersion,
};
const validSignature = verify(
  null,
  Buffer.from(canonical(signedPayload), 'utf8'),
  createPublicKey(required('PROVIDER_MANIFEST_PUBLIC_KEY_PEM').replaceAll('\\n', '\n')),
  Buffer.from(manifest.signature, 'base64'),
);
if (!validSignature) throw new Error('PROVIDER_MANIFEST_SIGNATURE_INVALID');

const governanceDatabaseUrl = required('GOVERNANCE_DATABASE_URL');
const runtimeDatabaseUrl = required('PROVIDER_RUNTIME_DATABASE_URL');
assertProductionDatabaseTransport('GOVERNANCE_DATABASE_URL', governanceDatabaseUrl);
assertProductionDatabaseTransport('PROVIDER_RUNTIME_DATABASE_URL', runtimeDatabaseUrl);
const governance = createPostgresProviderGovernanceStore(
  governanceDatabaseUrl,
  'rhea_provider_governance_admin',
);
const runtime = createPostgresProviderGovernanceStore(runtimeDatabaseUrl, 'rhea_provider_gateway');
try {
  const validator = new ProviderGovernanceService(new MemoryProviderGovernanceStore());
  for (const capability of manifest.capabilities) await validator.registerCapability(capability);
  await governance.store.saveCapabilitiesAtomically(manifest.capabilities);
  for (const expected of manifest.capabilities) {
    const visible = await runtime.store.findCapability(expected.capabilityVersionId);
    if (!visible || !providerCapabilitiesEqual(visible, expected))
      throw new Error(`PROVIDER_CAPABILITY_RUNTIME_SMOKE_FAILED:${expected.capabilityVersionId}`);
  }
  console.log(
    JSON.stringify({
      approvedAt: manifest.approvedAt,
      approvedBy: manifest.approvedBy,
      imported: manifest.capabilities.length,
      runtimeSmoke: 'passed',
    }),
  );
} finally {
  await Promise.all([governance.pool.end(), runtime.pool.end()]);
}

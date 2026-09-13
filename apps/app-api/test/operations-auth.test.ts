import { describe, expect, it } from 'vitest';

import { validateProductionOperationsCredentials } from '../src/operations/operations-auth.js';

const roles = {
  'child-safety': 'child_safety',
  compliance: 'compliance',
  'domain-reviewer': 'domain_reviewer',
  'metrics-operator': 'metrics_operator',
  'privacy-owner': 'privacy_owner',
  'quality-owner': 'quality_owner',
  'release-manager': 'release_manager',
  'safety-operator': 'safety_operator',
};

function environment(tokens: Record<string, string>) {
  return {
    OPERATIONS_PRINCIPAL_ROLES: JSON.stringify(roles),
    OPERATIONS_PRINCIPAL_TOKENS: JSON.stringify(tokens),
  };
}

describe('production operations credential validation', () => {
  it('accepts complete role-separated principal maps with globally unique tokens', () => {
    const tokens = Object.fromEntries(
      Object.keys(roles).map((principal, index) => [
        principal,
        `unique-operations-token-${String(index).padStart(3, '0')}`,
      ]),
    );
    expect(() => validateProductionOperationsCredentials(environment(tokens))).not.toThrow();
  });

  it('rejects a token shared by two operational identities', () => {
    const tokens = Object.fromEntries(
      Object.keys(roles).map((principal) => [principal, `unique-token-for-${principal}-000000`]),
    );
    tokens['quality-owner'] = tokens['release-manager']!;
    expect(() => validateProductionOperationsCredentials(environment(tokens))).toThrow(
      'globally unique',
    );
  });

  it('rejects mismatched principals and missing independent roles', () => {
    expect(() =>
      validateProductionOperationsCredentials(
        environment({ 'quality-owner': 'unique-quality-token-00000001' }),
      ),
    ).toThrow('principal sets must match');
    const incompleteRoles = { ...roles } as Record<string, string>;
    delete incompleteRoles.compliance;
    const tokens = Object.fromEntries(
      Object.keys(incompleteRoles).map((principal) => [
        principal,
        `unique-token-for-${principal}-000000`,
      ]),
    );
    expect(() =>
      validateProductionOperationsCredentials({
        OPERATIONS_PRINCIPAL_ROLES: JSON.stringify(incompleteRoles),
        OPERATIONS_PRINCIPAL_TOKENS: JSON.stringify(tokens),
      }),
    ).toThrow('missing required roles');
  });
});

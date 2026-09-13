export type OperationsRole =
  | 'child_safety'
  | 'compliance'
  | 'domain_reviewer'
  | 'metrics_operator'
  | 'privacy_owner'
  | 'quality_owner'
  | 'release_manager'
  | 'safety_operator';

const ALLOWED_ROLES: OperationsRole[] = [
  'child_safety',
  'compliance',
  'domain_reviewer',
  'metrics_operator',
  'privacy_owner',
  'quality_owner',
  'release_manager',
  'safety_operator',
];

function stringMap(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())
    )
      return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return null;
  }
}

export function operationsCredential(
  environment: Record<string, string | undefined>,
  principalId: string,
): { role: OperationsRole; token: string } | null {
  const tokens = stringMap(environment.OPERATIONS_PRINCIPAL_TOKENS);
  const roles = stringMap(environment.OPERATIONS_PRINCIPAL_ROLES);
  const token = tokens?.[principalId];
  const role = roles?.[principalId];
  return token && token.length >= 24 && role && ALLOWED_ROLES.includes(role as OperationsRole)
    ? { role: role as OperationsRole, token }
    : null;
}

export function validateProductionOperationsCredentials(
  environment: Record<string, string | undefined>,
) {
  const tokens = stringMap(environment.OPERATIONS_PRINCIPAL_TOKENS);
  const roles = stringMap(environment.OPERATIONS_PRINCIPAL_ROLES);
  if (!tokens || !roles) throw new Error('Operations principal maps must be valid JSON objects');
  const tokenPrincipals = Object.keys(tokens).sort();
  const rolePrincipals = Object.keys(roles).sort();
  if (JSON.stringify(tokenPrincipals) !== JSON.stringify(rolePrincipals))
    throw new Error('Operations token and role principal sets must match');
  if (Object.values(tokens).some((token) => token.length < 24))
    throw new Error('Every operations token must contain at least 24 characters');
  if (new Set(Object.values(tokens)).size !== tokenPrincipals.length)
    throw new Error('Operations tokens must be globally unique');
  if (Object.values(roles).some((role) => !ALLOWED_ROLES.includes(role as OperationsRole)))
    throw new Error('Operations role map contains an unsupported role');
  const configuredRoles = new Set(Object.values(roles));
  const missingRoles = ALLOWED_ROLES.filter((role) => !configuredRoles.has(role));
  if (missingRoles.length)
    throw new Error(`Operations role map is missing required roles: ${missingRoles.join(',')}`);
}

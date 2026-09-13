import type { ProviderCapability } from './types.js';

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

export function providerCapabilityFingerprint(value: ProviderCapability): string {
  return canonical({
    ...value,
    allowedDataCategories: [...new Set(value.allowedDataCategories)].sort(),
    allowedOrigins: [...new Set(value.allowedOrigins)].sort(),
  });
}

export function providerCapabilitiesEqual(
  left: ProviderCapability,
  right: ProviderCapability,
): boolean {
  return providerCapabilityFingerprint(left) === providerCapabilityFingerprint(right);
}

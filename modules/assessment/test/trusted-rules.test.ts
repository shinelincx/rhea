import { describe, expect, it } from 'vitest';

import { deriveTrustedBuiltInRule } from '../src/index.js';

describe('trusted built-in objective rules', () => {
  it.each([
    ['6 × 7 = ?', '42'],
    ['36 ÷ 4 =', '9'],
    ['18 - 25', '-7'],
    ['12 + 30', '42'],
  ])('derives a versioned numeric rule for %s', (text, expected) => {
    expect(
      deriveTrustedBuiltInRule({ subject: 'mathematics', text, versionId: 'question-v1' }),
    ).toEqual({
      gradingRuleVersionId: 'builtin:integer-arithmetic:v1',
      rule: { expected, kind: 'numeric' },
    });
  });

  it('fails closed for unsupported, unsafe, or non-mathematics prompts', () => {
    expect(
      deriveTrustedBuiltInRule({
        subject: 'english',
        text: '6 + 7 = ?',
        versionId: 'question-v1',
      }),
    ).toBeNull();
    expect(
      deriveTrustedBuiltInRule({
        subject: 'mathematics',
        text: '10 ÷ 0 = ?',
        versionId: 'question-v1',
      }),
    ).toBeNull();
    expect(
      deriveTrustedBuiltInRule({
        subject: 'mathematics',
        text: '请说明 3 + 4 的两种解题思路',
        versionId: 'question-v1',
      }),
    ).toBeNull();
  });
});

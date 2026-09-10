import type { CapabilityVersion } from '@rhea/quality-control';

import type { FileInspectionPort, RecognitionPort } from './ports.js';

export const deterministicRecognitionCapability: CapabilityVersion = {
  adapter: { id: 'deterministic-ocr', version: 'deterministic-ocr-v1' },
  artifactHash: 'a'.repeat(64),
  capabilityKey: 'ocr.recognition',
  id: '11111111-1111-4111-8111-111111111111',
  implementedBy: '33333333-3333-4333-8333-333333333333',
  kind: 'ocr',
  modelOrEngine: { id: 'deterministic-engine', version: 'engine-v1' },
  policyVersion: 'ocr-policy-v1',
  promptOrConfig: { kind: 'config', version: 'ocr-config-v1' },
  provider: { id: 'rhea-deterministic', version: 'provider-contract-v1' },
  region: 'cn-shanghai',
  registeredAt: '2026-09-10T08:00:00.000Z',
  requiredSlicePolicyVersion: 'ocr-quality-policy-v1',
  templateVersion: 'not-applicable-v1',
};

function detectedMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (prefix.startsWith('%PDF-')) {
    return 'application/pdf';
  }
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export const deterministicFileInspection: FileInspectionPort = {
  async inspect(page, bytes) {
    const text = new TextDecoder().decode(bytes);
    const actualMimeType = detectedMime(bytes);
    const qualityIssues = [
      ...(page.width !== null && page.height !== null && Math.min(page.width, page.height) < 900
        ? (['blurry'] as const)
        : []),
      ...(text.includes('RHEA_TOO_DARK') ? (['too_dark'] as const) : []),
      ...(text.includes('RHEA_GLARE') ? (['glare'] as const) : []),
      ...(text.includes('RHEA_MISSING_EDGE') ? (['missing_edge'] as const) : []),
    ];
    return {
      actualMimeType,
      qualityIssues,
      safe:
        actualMimeType !== null &&
        actualMimeType === page.mimeType &&
        !text.includes('EICAR') &&
        !text.includes('<script'),
    };
  },
};

export const deterministicRecognition: RecognitionPort = {
  async recognize({ pages }) {
    return {
      regions: pages.flatMap(({ page }, pageIndex) => [
        {
          confidence: pageIndex === 0 ? 0.97 : 0.62,
          id: `${page.id}:question`,
          kind: 'question' as const,
          lowConfidence: pageIndex !== 0,
          pageId: page.id,
          polygon: [
            { x: 0.08, y: 0.12 },
            { x: 0.92, y: 0.12 },
            { x: 0.92, y: 0.32 },
            { x: 0.08, y: 0.32 },
          ],
          questionRegionId: null,
          readingOrder: pageIndex * 2,
          text: pageIndex === 0 ? '计算：36 ÷ 4 =' : '请确认这段识别文字',
        },
        {
          confidence: 0.95,
          id: `${page.id}:answer`,
          kind: 'answer' as const,
          lowConfidence: false,
          pageId: page.id,
          polygon: [
            { x: 0.5, y: 0.34 },
            { x: 0.76, y: 0.34 },
            { x: 0.76, y: 0.44 },
            { x: 0.5, y: 0.44 },
          ],
          questionRegionId: `${page.id}:question`,
          readingOrder: pageIndex * 2 + 1,
          text: '8',
        },
      ]),
    };
  },
};

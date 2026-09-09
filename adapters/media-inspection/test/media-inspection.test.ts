import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { detectMediaType, sharpFileInspection } from '../src/index.js';

describe('backend media inspection', () => {
  it('sniffs supported magic bytes instead of trusting the declared type', () => {
    expect(detectMediaType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectMediaType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMediaType(new TextEncoder().encode('<script>'))).toBeNull();
  });

  it('reports obvious dark and low-resolution image quality on the backend', async () => {
    const bytes = await sharp({
      create: { background: { b: 8, g: 8, r: 8 }, channels: 3, height: 600, width: 800 },
    })
      .jpeg()
      .toBuffer();
    const result = await sharpFileInspection.inspect(
      {
        crop: null,
        fileName: '暗图.jpg',
        height: 600,
        id: 'page-1',
        mimeType: 'image/jpeg',
        objectKey: 'test',
        observedMimeType: null,
        order: 0,
        rotation: 0,
        sha256: '0'.repeat(64),
        sizeBytes: bytes.byteLength,
        uploadedAt: new Date().toISOString(),
        width: 800,
      },
      bytes,
    );
    expect(result).toMatchObject({ actualMimeType: 'image/jpeg', safe: true });
    expect(result.qualityIssues).toEqual(expect.arrayContaining(['blurry', 'too_dark']));
  });

  it('rejects content whose observed type does not match its declaration', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    const result = await sharpFileInspection.inspect(
      {
        crop: null,
        fileName: '伪装.jpg',
        height: null,
        id: 'page-1',
        mimeType: 'image/jpeg',
        objectKey: 'test',
        observedMimeType: null,
        order: 0,
        rotation: 0,
        sha256: '0'.repeat(64),
        sizeBytes: bytes.byteLength,
        uploadedAt: new Date().toISOString(),
        width: null,
      },
      bytes,
    );
    expect(result.safe).toBe(false);
  });
});

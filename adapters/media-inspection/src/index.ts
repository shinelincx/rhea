import type { FileInspectionPort, QualityIssue } from '@rhea/submission';
import sharp from 'sharp';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function detectMediaType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (ascii(bytes, 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return brand.startsWith('hei') ? 'image/heic' : 'image/heif';
    }
  }
  return null;
}

function imageQualityIssues(
  data: Buffer,
  info: { channels: number; height: number; width: number },
  original: { height: number; width: number },
): QualityIssue[] {
  const luminance = new Float32Array(info.width * info.height);
  let sum = 0;
  let squares = 0;
  let clipped = 0;
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const offset = pixel * info.channels;
    const light =
      (0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255;
    luminance[pixel] = light;
    sum += light;
    squares += light * light;
    if (light > 0.985) {
      clipped += 1;
    }
  }
  const brightness = sum / Math.max(1, luminance.length);
  const contrast = Math.sqrt(
    Math.max(0, squares / Math.max(1, luminance.length) - brightness * brightness),
  );
  let laplacianSquares = 0;
  let samples = 0;
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const center = y * info.width + x;
      const laplacian =
        4 * luminance[center]! -
        luminance[center - 1]! -
        luminance[center + 1]! -
        luminance[center - info.width]! -
        luminance[center + info.width]!;
      laplacianSquares += laplacian * laplacian;
      samples += 1;
    }
  }
  const border = Math.max(1, Math.round(Math.min(info.width, info.height) * 0.03));
  let borderPixels = 0;
  let brightBorder = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (x >= border && x < info.width - border && y >= border && y < info.height - border) {
        continue;
      }
      borderPixels += 1;
      if (luminance[y * info.width + x]! > 0.88) {
        brightBorder += 1;
      }
    }
  }

  return [
    ...(Math.min(original.width, original.height) < 900 ||
    laplacianSquares / Math.max(1, samples) < 0.003
      ? (['blurry'] as const)
      : []),
    ...(brightness < 0.2 ? (['too_dark'] as const) : []),
    ...(contrast > 0.16 && clipped / Math.max(1, luminance.length) > 0.25
      ? (['glare'] as const)
      : []),
    ...(brightBorder / Math.max(1, borderPixels) > 0.9 ? (['missing_edge'] as const) : []),
  ];
}

export const sharpFileInspection: FileInspectionPort = {
  async inspect(page, bytes) {
    const actualMimeType = detectMediaType(bytes);
    const sample = new TextDecoder().decode(bytes.slice(0, 4_096)).toLowerCase();
    const declaredMatches =
      actualMimeType === page.mimeType ||
      (actualMimeType === 'image/heif' && page.mimeType === 'image/heic') ||
      (actualMimeType === 'image/heic' && page.mimeType === 'image/heif');
    if (
      !actualMimeType ||
      !declaredMatches ||
      sample.includes('eicar') ||
      sample.includes('<script')
    ) {
      return { actualMimeType, qualityIssues: [], safe: false };
    }
    if (actualMimeType === 'application/pdf' || actualMimeType.startsWith('image/hei')) {
      return { actualMimeType, qualityIssues: [], safe: true };
    }
    try {
      const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        (metadata.pages !== undefined && metadata.pages > 1)
      ) {
        return { actualMimeType, qualityIssues: [], safe: false };
      }
      const { data, info } = await image
        .rotate()
        .resize({ width: 256, withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        actualMimeType,
        qualityIssues: imageQualityIssues(data, info, {
          height: metadata.height,
          width: metadata.width,
        }),
        safe: true,
      };
    } catch {
      return { actualMimeType, qualityIssues: [], safe: false };
    }
  },
};

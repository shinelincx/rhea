import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { decode } from 'jpeg-js';

import { inferQualityWarnings, type DraftQualityWarning, type QualityMetrics } from './model';

interface PixelImage {
  data: Uint8Array;
  height: number;
  width: number;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function deriveImageQualityMetrics(image: PixelImage): QualityMetrics {
  const pixels = image.width * image.height;
  const luminance = new Float32Array(pixels);
  let sum = 0;
  let clipped = 0;
  let sumOfSquares = 0;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    const light =
      (0.2126 * image.data[offset]! +
        0.7152 * image.data[offset + 1]! +
        0.0722 * image.data[offset + 2]!) /
      255;
    luminance[pixel] = light;
    sum += light;
    sumOfSquares += light * light;
    if (light > 0.985) {
      clipped += 1;
    }
  }

  let laplacianSum = 0;
  let laplacianSquares = 0;
  let laplacianSamples = 0;
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const center = y * image.width + x;
      const laplacian =
        4 * luminance[center]! -
        luminance[center - 1]! -
        luminance[center + 1]! -
        luminance[center - image.width]! -
        luminance[center + image.width]!;
      laplacianSum += laplacian;
      laplacianSquares += laplacian * laplacian;
      laplacianSamples += 1;
    }
  }

  const brightness = pixels === 0 ? 0 : sum / pixels;
  const contrast = Math.sqrt(Math.max(0, sumOfSquares / Math.max(1, pixels) - brightness ** 2));
  const laplacianMean = laplacianSum / Math.max(1, laplacianSamples);
  const sharpness =
    laplacianSquares / Math.max(1, laplacianSamples) - laplacianMean * laplacianMean;

  const border = Math.max(1, Math.round(Math.min(image.width, image.height) * 0.03));
  let brightBorder = 0;
  let borderPixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (x >= border && x < image.width - border && y >= border && y < image.height - border) {
        continue;
      }
      borderPixels += 1;
      if (luminance[y * image.width + x]! > 0.88) {
        brightBorder += 1;
      }
    }
  }

  return {
    brightness,
    edgeCoverage: brightBorder / Math.max(1, borderPixels) > 0.9 ? 0.7 : 1,
    glareRatio: contrast > 0.16 ? clipped / Math.max(1, pixels) : 0,
    height: sharpness < 0.004 ? 600 : 1_200,
    width: sharpness < 0.004 ? 800 : 1_200,
  };
}

export async function analyzeImageQuality(input: {
  height?: number | null;
  uri: string;
  width?: number | null;
}): Promise<DraftQualityWarning[]> {
  const dimensions = inferQualityWarnings({
    ...(input.height == null ? {} : { height: input.height }),
    ...(input.width == null ? {} : { width: input.width }),
  });
  try {
    const context = ImageManipulator.manipulate(input.uri);
    context.resize({ width: 240 });
    const image = await context.renderAsync();
    const thumbnail = await image.saveAsync({
      base64: true,
      compress: 0.8,
      format: SaveFormat.JPEG,
    });
    if (!thumbnail.base64) {
      return dimensions;
    }
    const decoded = decode(base64Bytes(thumbnail.base64), {
      formatAsRGBA: true,
      maxMemoryUsageInMB: 16,
      maxResolutionInMP: 1,
      useTArray: true,
    });
    return [
      ...new Set([...dimensions, ...inferQualityWarnings(deriveImageQualityMetrics(decoded))]),
    ];
  } catch {
    return dimensions;
  }
}

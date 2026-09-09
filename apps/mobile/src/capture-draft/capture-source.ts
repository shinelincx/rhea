import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';
import { File as ExpoFile } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import type { DraftPage } from './model';

export interface CapturedDraftPage {
  bytes: Uint8Array;
  page: DraftPage;
  previewUri: string | null;
}

export interface CaptureSource {
  importFiles(): Promise<CapturedDraftPage[]>;
  takePhoto(): Promise<CapturedDraftPage[]>;
}

async function bytesFromAsset(uri: string, browserFile?: File): Promise<Uint8Array> {
  if (browserFile) {
    return new Uint8Array(await browserFile.arrayBuffer());
  }
  return new ExpoFile(uri).bytes();
}

function imagePage(input: {
  fileName: string;
  height: number;
  id: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
}): DraftPage {
  return {
    crop: null,
    fileName: input.fileName,
    height: input.height || null,
    id: input.id,
    mimeType: input.mimeType,
    qualityWarnings: [],
    rotation: 0,
    sizeBytes: input.sizeBytes,
    width: input.width || null,
  };
}

async function fromImagePickerAsset(
  asset: ImagePicker.ImagePickerAsset,
): Promise<CapturedDraftPage> {
  const bytes = await bytesFromAsset(asset.uri, asset.file);
  const page = imagePage({
    fileName: asset.fileName ?? `作业照片-${Date.now()}.jpg`,
    height: asset.height,
    id: randomUUID(),
    mimeType: asset.mimeType ?? 'image/jpeg',
    sizeBytes: asset.fileSize ?? bytes.byteLength,
    width: asset.width,
  });
  return {
    bytes,
    page,
    previewUri: asset.uri,
  };
}

async function takePhoto(): Promise<CapturedDraftPage[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('需要相机权限才能拍摄作业；也可以改用“导入图片或 PDF”。');
  }
  const result = await ImagePicker.launchCameraAsync({
    cameraType: ImagePicker.CameraType.back,
    mediaTypes: ['images'],
    quality: 1,
  });
  return result.canceled ? [] : Promise.all(result.assets.map(fromImagePickerAsset));
}

async function importFiles(): Promise<CapturedDraftPage[]> {
  const result = await DocumentPicker.getDocumentAsync({
    base64: false,
    copyToCacheDirectory: true,
    multiple: true,
    type: ['image/*', 'application/pdf'],
  });
  if (result.canceled) {
    return [];
  }
  return Promise.all(
    result.assets.map(async (asset) => {
      const bytes = await bytesFromAsset(asset.uri, asset.file);
      const mimeType = asset.mimeType ?? 'application/octet-stream';
      return {
        bytes,
        page: {
          crop: null,
          fileName: asset.name,
          height: null,
          id: randomUUID(),
          mimeType,
          qualityWarnings: [],
          rotation: 0,
          sizeBytes: asset.size ?? bytes.byteLength,
          width: null,
        },
        previewUri: mimeType.startsWith('image/') ? asset.uri : null,
      } satisfies CapturedDraftPage;
    }),
  );
}

export const expoCaptureSource: CaptureSource = { importFiles, takePhoto };

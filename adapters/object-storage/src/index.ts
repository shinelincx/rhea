import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorePort } from '@rhea/submission';

export interface S3ObjectStoreOptions {
  bucket: string;
  client: S3Client;
  kmsKeyId?: string;
}

function notFound(error: unknown): boolean {
  return (
    error instanceof NoSuchKey ||
    error instanceof NotFound ||
    (typeof error === 'object' &&
      error !== null &&
      '$metadata' in error &&
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
  );
}

export class S3ObjectStore implements ObjectStorePort {
  constructor(private readonly options: S3ObjectStoreOptions) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.options.client.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: this.options.bucket,
        Key: key,
        ...(this.options.kmsKeyId
          ? {
              SSEKMSKeyId: this.options.kmsKeyId,
              ServerSideEncryption: 'aws:kms' as const,
            }
          : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.options.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return result.Body ? new Uint8Array(await result.Body.transformToByteArray()) : null;
    } catch (error) {
      if (notFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<{ proof: string }> {
    const deleted = await this.options.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    try {
      await this.options.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      throw new Error('Object deletion could not be verified');
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
    }
    return {
      proof: `s3-delete:${deleted.$metadata.requestId ?? 'no-request-id'}:${new Date().toISOString()}`,
    };
  }
}

export function createS3ObjectStore(input: {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle?: boolean;
  kmsKeyId?: string;
  region: string;
  secretAccessKey: string;
}): { client: S3Client; store: S3ObjectStore } {
  const client = new S3Client({
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
    endpoint: input.endpoint,
    forcePathStyle: input.forcePathStyle ?? false,
    region: input.region,
  });
  return {
    client,
    store: new S3ObjectStore({
      bucket: input.bucket,
      client,
      ...(input.kmsKeyId ? { kmsKeyId: input.kmsKeyId } : {}),
    }),
  };
}

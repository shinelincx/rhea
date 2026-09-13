import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorePort } from '@rhea/submission';
import { readWorkloadCredentialFile } from '@rhea/workload-credentials-adapter';

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
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    const versions: Array<{ key: string; versionId: string }> = [];
    do {
      const page = await this.options.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.options.bucket,
          KeyMarker: keyMarker,
          Prefix: key,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (item.Key === key && item.VersionId)
          versions.push({ key: item.Key, versionId: item.VersionId });
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);

    let requestId = 'no-request-id';
    if (versions.length === 0) {
      try {
        await this.options.client.send(
          new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
        );
        throw new Error(
          'Object exists but has no enumerable version; refusing to create a delete marker',
        );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    } else {
      for (const version of versions) {
        const deleted = await this.options.client.send(
          new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: version.key,
            VersionId: version.versionId,
          }),
        );
        requestId = deleted.$metadata.requestId ?? requestId;
      }
    }
    const remaining = await this.options.client.send(
      new ListObjectVersionsCommand({ Bucket: this.options.bucket, Prefix: key }),
    );
    if (
      [...(remaining.Versions ?? []), ...(remaining.DeleteMarkers ?? [])].some(
        (item) => item.Key === key,
      )
    ) {
      throw new Error('Object version deletion could not be verified');
    }
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
      proof: `s3-delete-all-versions:${versions.length}:${requestId}:${new Date().toISOString()}`,
    };
  }

  async listPrefix(prefix: string): Promise<Array<{ bytes: Uint8Array; key: string }>> {
    const result: Array<{ bytes: Uint8Array; key: string }> = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.options.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          ContinuationToken: continuationToken,
          Prefix: prefix,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        const bytes = await this.get(item.Key);
        if (bytes) result.push({ bytes, key: item.Key });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return result;
  }
}

type S3CredentialInput =
  | {
      accessKeyId: string;
      baseRamRoleName?: never;
      credentialsFile?: never;
      expectedRoleArn?: never;
      secretAccessKey: string;
      workloadRoleArn?: never;
    }
  | {
      accessKeyId?: never;
      credentialsFile: string;
      expectedRoleArn: string;
      secretAccessKey?: never;
    };

export function createS3ObjectStore(
  input: {
    bucket: string;
    endpoint: string;
    forcePathStyle?: boolean;
    kmsKeyId?: string;
    region: string;
  } & S3CredentialInput,
): { client: S3Client; store: S3ObjectStore } {
  if (input.credentialsFile) {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new Error('Production object storage endpoint must be a valid URL');
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== 'oss-cn-shanghai-internal.aliyuncs.com' ||
      input.region !== 'cn-shanghai'
    ) {
      throw new Error('Production object storage must use the internal cn-shanghai HTTPS endpoint');
    }
    if (!/^acs:ram::\d+:role\/[a-z0-9-]+$/i.test(input.expectedRoleArn)) {
      throw new Error('Production object storage workload role ARN is invalid');
    }
  }
  const credentials = input.credentialsFile
    ? async () => {
        const value = await readWorkloadCredentialFile(
          input.credentialsFile,
          input.expectedRoleArn,
        );
        return {
          accessKeyId: value.accessKeyId,
          secretAccessKey: value.accessKeySecret,
          expiration: new Date(value.expiresAt),
          sessionToken: value.securityToken,
        };
      }
    : {
        accessKeyId: input.accessKeyId!,
        secretAccessKey: input.secretAccessKey!,
      };
  const client = new S3Client({
    credentials,
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

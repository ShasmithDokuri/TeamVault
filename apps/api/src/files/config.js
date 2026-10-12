const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const ALLOWED_CONTENT_TYPES = Object.freeze([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

function readFileStorageConfig(env = process.env) {
  const bucket = env.S3_BUCKET?.trim() || null;
  const region = env.AWS_REGION?.trim() || null;
  if (bucket && !region) {
    throw new Error('AWS_REGION is required when S3_BUCKET is configured.');
  }
  const maxFileBytes = env.FILE_MAX_BYTES === undefined ? MAX_FILE_BYTES : Number(env.FILE_MAX_BYTES);
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw new Error(`FILE_MAX_BYTES must be an integer between 1 and ${MAX_FILE_BYTES}.`);
  }
  const maxConcurrentUploads = env.FILE_MAX_CONCURRENT_UPLOADS === undefined
    ? DEFAULT_MAX_CONCURRENT_UPLOADS : Number(env.FILE_MAX_CONCURRENT_UPLOADS);
  if (!Number.isInteger(maxConcurrentUploads) || maxConcurrentUploads < 1 || maxConcurrentUploads > 8) {
    throw new Error('FILE_MAX_CONCURRENT_UPLOADS must be an integer between 1 and 8.');
  }
  return Object.freeze({ bucket, region, maxFileBytes, maxConcurrentUploads, enabled: Boolean(bucket) });
}

module.exports = { ALLOWED_CONTENT_TYPES, DEFAULT_MAX_CONCURRENT_UPLOADS, MAX_FILE_BYTES, readFileStorageConfig };

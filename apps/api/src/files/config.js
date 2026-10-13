const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_LOCAL_STORAGE_PATH = '/var/lib/teamvault/files';

const ALLOWED_CONTENT_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function readFileStorageConfig(env = process.env) {
  const driver = env.FILE_STORAGE_DRIVER?.trim() || 's3';
  const bucket = env.S3_BUCKET?.trim() || null;
  const region = env.AWS_REGION?.trim() || null;
  const localPath = env.FILE_STORAGE_PATH?.trim() || DEFAULT_LOCAL_STORAGE_PATH;

  if (!['s3', 'local'].includes(driver)) {
    throw new Error('FILE_STORAGE_DRIVER must be either s3 or local.');
  }

  if (driver === 's3' && bucket && !region) {
    throw new Error('AWS_REGION is required when S3_BUCKET is configured.');
  }

  if (driver === 'local' && !localPath) {
    throw new Error('FILE_STORAGE_PATH is required for local file storage.');
  }

  const maxFileBytes = env.FILE_MAX_BYTES === undefined
    ? MAX_FILE_BYTES
    : Number(env.FILE_MAX_BYTES);

  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw new Error(`FILE_MAX_BYTES must be an integer between 1 and ${MAX_FILE_BYTES}.`);
  }

  const maxConcurrentUploads = env.FILE_MAX_CONCURRENT_UPLOADS === undefined
    ? DEFAULT_MAX_CONCURRENT_UPLOADS
    : Number(env.FILE_MAX_CONCURRENT_UPLOADS);

  if (!Number.isInteger(maxConcurrentUploads) || maxConcurrentUploads < 1 || maxConcurrentUploads > 8) {
    throw new Error('FILE_MAX_CONCURRENT_UPLOADS must be an integer between 1 and 8.');
  }

  return Object.freeze({
    driver,
    bucket,
    region,
    localPath,
    maxFileBytes,
    maxConcurrentUploads,
    enabled: driver === 'local' || Boolean(bucket),
  });
}

module.exports = {
  ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  MAX_FILE_BYTES,
  readFileStorageConfig,
};

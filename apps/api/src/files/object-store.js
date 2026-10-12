const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');

function createS3ObjectStore({ bucket, region, client = new S3Client({ region }) }) {
  function requireBucket() {
    if (!bucket) {
      const error = new Error('Private file storage is not configured.');
      error.code = 'FILE_STORAGE_UNAVAILABLE';
      throw error;
    }
    return bucket;
  }

  return Object.freeze({
    async put({ key, body, contentType }) {
      await client.send(new PutObjectCommand({
        Bucket: requireBucket(),
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        CacheControl: 'private, no-store',
      }));
    },
    get({ key }) {
      return client.send(new GetObjectCommand({ Bucket: requireBucket(), Key: key }));
    },
    async delete({ key }) {
      await client.send(new DeleteObjectCommand({ Bucket: requireBucket(), Key: key }));
    },
  });
}

module.exports = { createS3ObjectStore };

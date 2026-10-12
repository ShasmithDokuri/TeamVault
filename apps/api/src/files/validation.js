const { ALLOWED_CONTENT_TYPES } = require('./config');

function validateUpload({ body, contentType, originalName, maxFileBytes }) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > maxFileBytes) return null;
  const normalizedType = typeof contentType === 'string' ? contentType.toLowerCase().trim() : '';
  if (!ALLOWED_CONTENT_TYPES.includes(normalizedType) || !matchesSignature(body, normalizedType)) return null;
  if (typeof originalName !== 'string') return null;
  const name = originalName.trim();
  if (
    name.length < 1 || name.length > 255 || name === '.' || name === '..'
    || /[\\/\p{Cc}]/u.test(name)
    || !/^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u.test(name)
  ) return null;
  return { body, contentType: normalizedType, originalName: name, sizeBytes: body.length };
}

function matchesSignature(body, contentType) {
  if (contentType === 'application/pdf') {
    return body.length >= 12 && body.subarray(0, 5).toString('ascii') === '%PDF-'
      && /%%EOF\s*$/u.test(body.subarray(Math.max(0, body.length - 1024)).toString('latin1'));
  }
  if (contentType === 'image/png') {
    return hasPngStructure(body);
  }
  if (contentType === 'image/jpeg') return hasJpegStructure(body);
  if (contentType === 'image/webp') {
    return body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF'
      && body.readUInt32LE(4) === body.length - 8
      && body.subarray(8, 12).toString('ascii') === 'WEBP'
      && hasWebpImageChunk(body);
  }
  return false;
}

function hasJpegStructure(body) {
  if (body.length < 12 || body[0] !== 0xff || body[1] !== 0xd8
      || body[body.length - 2] !== 0xff || body[body.length - 1] !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset < body.length - 2) {
    if (body[offset] !== 0xff) return false;
    while (body[offset] === 0xff) offset += 1;
    if (offset >= body.length) return false;
    const marker = body[offset++];
    if (marker === 0xd9 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > body.length) return false;
    const segmentLength = body.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > body.length) return false;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) hasFrame = true;
    if (marker === 0xda) return hasFrame && offset + segmentLength < body.length - 2;
    offset += segmentLength;
  }
  return false;
}

function hasWebpImageChunk(body) {
  let offset = 12;
  while (offset + 8 <= body.length) {
    const kind = body.subarray(offset, offset + 4).toString('ascii');
    const length = body.readUInt32LE(offset + 4);
    const paddedLength = length + (length % 2);
    if (offset + 8 + paddedLength > body.length) return false;
    if (['VP8 ', 'VP8L'].includes(kind) && length > 0) return true;
    offset += 8 + paddedLength;
  }
  return false;
}

function hasPngStructure(body) {
  if (body.length < 45 || !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  if (body.readUInt32BE(8) !== 13 || body.subarray(12, 16).toString('ascii') !== 'IHDR'
      || body.readUInt32BE(16) === 0 || body.readUInt32BE(20) === 0) return false;
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset);
    const kind = body.subarray(offset + 4, offset + 8).toString('ascii');
    const next = offset + 12 + length;
    if (next > body.length) return false;
    if (kind === 'IDAT' && length > 0) hasImageData = true;
    if (kind === 'IEND') return length === 0 && next === body.length && hasImageData;
    offset = next;
  }
  return false;
}

module.exports = { hasJpegStructure, hasPngStructure, hasWebpImageChunk, matchesSignature, validateUpload };

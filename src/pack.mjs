import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const PACK_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  uncompressedBytes: 24 * 1024 * 1024,
  fileBytes: 3 * 1024 * 1024,
  files: 128,
  frames: 96,
  states: 12,
  dimension: 512,
  manifestBytes: 32 * 1024,
});

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ALLOWED_PATH = /^(?:companion\.json|frames\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.png)$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SAFE_STATE = /^[a-z][a-z0-9-]{0,31}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PackValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PackValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackValidationError(code, message);
}

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  fail('INVALID_ZIP', 'The ZIP end-of-directory record is missing.');
}

export function inspectZip(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('INVALID_ARCHIVE', 'Archive must be bytes.');
  if (bytes.byteLength === 0 || bytes.byteLength > PACK_LIMITS.archiveBytes) {
    fail('ARCHIVE_SIZE', 'Archive exceeds the 8 MiB limit.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    fail('MULTI_DISK_ZIP', 'Multi-disk ZIP archives are not supported.');
  }
  if (entries === 0 || entries > PACK_LIMITS.files) fail('FILE_COUNT', 'Too many files.');
  if (centralOffset + centralSize > eocd) fail('INVALID_ZIP', 'Invalid central directory.');

  let offset = centralOffset;
  let total = 0;
  const names = new Set();
  const records = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      fail('INVALID_ZIP', 'Invalid central-directory entry.');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.byteLength) fail('INVALID_ZIP');

    let name;
    try {
      name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch {
      fail('INVALID_PATH', 'File names must be UTF-8.');
    }

    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if ((flags & 0x1) !== 0) fail('ENCRYPTED_ZIP', 'Encrypted ZIP entries are not accepted.');
    if (method !== 0 && method !== 8) fail('ZIP_METHOD', 'Unsupported ZIP compression method.');
    if (fileType === 0xa000) fail('SYMLINK', 'Symbolic links are not accepted.');
    if (!ALLOWED_PATH.test(name) || name.includes('..') || name.startsWith('/')) {
      fail('INVALID_PATH', `Disallowed archive path: ${name}`);
    }
    if (names.has(name)) fail('DUPLICATE_PATH', `Duplicate archive path: ${name}`);
    if (uncompressedSize > PACK_LIMITS.fileBytes) fail('FILE_SIZE', `${name} is too large.`);
    if (uncompressedSize > 1024 * 1024 && compressedSize > 0 && uncompressedSize / compressedSize > 100) {
      fail('COMPRESSION_RATIO', `${name} has an unsafe compression ratio.`);
    }

    total += uncompressedSize;
    if (total > PACK_LIMITS.uncompressedBytes) fail('UNCOMPRESSED_SIZE', 'Archive expands beyond 24 MiB.');
    names.add(name);
    records.push({ name, compressedSize, uncompressedSize });
    offset = nameEnd + extraLength + commentLength;
  }

  if (offset !== centralOffset + centralSize) fail('INVALID_ZIP', 'Central-directory size mismatch.');
  return records;
}

function requireString(value, code, maximum = 80) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > maximum) {
    fail(code, `Invalid string for ${code}.`);
  }
  return value;
}

function readPngSize(bytes, path) {
  if (bytes.byteLength < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    fail('INVALID_PNG', `${path} is not a PNG image.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!width || !height || width > PACK_LIMITS.dimension || height > PACK_LIMITS.dimension) {
    fail('IMAGE_DIMENSIONS', `${path} exceeds the 512×512 limit.`);
  }
  return { width, height };
}

export function validateManifest(value, files) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MANIFEST');
  if (value.schemaVersion !== 1) fail('SCHEMA_VERSION', 'Only schemaVersion 1 is supported.');
  const id = requireString(value.id, 'id', 48);
  if (!SAFE_ID.test(id)) fail('INVALID_ID', 'id must be a lowercase slug.');
  if (!value.name || typeof value.name !== 'object') fail('INVALID_NAME');
  const name = {
    en: requireString(value.name.en, 'name.en'),
    zh: requireString(value.name.zh, 'name.zh'),
  };
  const width = Number(value.canvas?.width);
  const height = Number(value.canvas?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 ||
      width > PACK_LIMITS.dimension || height > PACK_LIMITS.dimension) {
    fail('INVALID_CANVAS', 'Canvas must be between 16 and 512 pixels per side.');
  }

  const statesInput = value.states;
  if (!statesInput || typeof statesInput !== 'object' || Array.isArray(statesInput)) fail('INVALID_STATES');
  const stateEntries = Object.entries(statesInput);
  if (stateEntries.length < 1 || stateEntries.length > PACK_LIMITS.states) fail('STATE_COUNT');
  const referenced = new Set();
  const states = {};
  let frameReferences = 0;

  for (const [stateName, state] of stateEntries) {
    if (!SAFE_STATE.test(stateName) || !state || typeof state !== 'object') fail('INVALID_STATE');
    if (!Array.isArray(state.frames) || state.frames.length < 1 || state.frames.length > PACK_LIMITS.frames) {
      fail('FRAME_COUNT');
    }
    const frames = state.frames.map((frame) => {
      const src = requireString(frame?.src, 'frame.src', 112);
      if (!/^frames\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.png$/.test(src) || !files[src]) {
        fail('MISSING_FRAME', `Missing referenced frame: ${src}`);
      }
      const durationMs = Number(frame.durationMs);
      if (!Number.isInteger(durationMs) || durationMs < 40 || durationMs > 2000) {
        fail('FRAME_DURATION', 'Frame duration must be between 40 and 2,000 ms.');
      }
      const dimensions = readPngSize(files[src], src);
      if (dimensions.width > width || dimensions.height > height) {
        fail('FRAME_CANVAS', `${src} is larger than the declared canvas.`);
      }
      referenced.add(src);
      frameReferences += 1;
      if (frameReferences > PACK_LIMITS.frames) fail('FRAME_COUNT');
      return { src, durationMs };
    });
    states[stateName] = { loop: state.loop !== false, frames };
  }

  const initialState = requireString(value.initialState, 'initialState', 32);
  if (!states[initialState]) fail('INITIAL_STATE');
  const presentFrames = Object.keys(files).filter((path) => path.startsWith('frames/'));
  if (presentFrames.some((path) => !referenced.has(path))) fail('UNREFERENCED_FRAME');

  return {
    schemaVersion: 1,
    id,
    name,
    canvas: { width, height },
    initialState,
    states,
  };
}

export function validateAndSanitizePack(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  inspectZip(bytes);
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    fail('INVALID_ZIP', 'Archive decompression failed.');
  }
  const manifestBytes = files['companion.json'];
  if (!manifestBytes || manifestBytes.byteLength > PACK_LIMITS.manifestBytes) fail('MANIFEST_SIZE');
  let rawManifest;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    fail('INVALID_JSON', 'companion.json is not valid JSON.');
  }
  const manifest = validateManifest(rawManifest, files);
  const sanitizedFiles = { 'companion.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`) };
  for (const path of [...new Set(Object.values(manifest.states).flatMap((state) => state.frames.map((frame) => frame.src)))].sort()) {
    sanitizedFiles[path] = files[path];
  }
  const sanitized = zipSync(sanitizedFiles, { level: 9, mtime: new Date('1980-01-02T00:00:00Z') });
  const sha256 = createHash('sha256').update(sanitized).digest('hex');
  return {
    bytes: sanitized,
    manifest,
    sha256,
    version: sha256.slice(0, 16),
    frameCount: Object.keys(sanitizedFiles).length - 1,
  };
}

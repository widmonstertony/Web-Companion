import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const PACK_LIMITS = Object.freeze({
  archiveBytes: 24 * 1024 * 1024,
  uncompressedBytes: 64 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
  files: 1024,
  companions: 12,
  instances: 8,
  mobileInstances: 4,
  frames: 768,
  framesPerState: 128,
  frameReferences: 4096,
  states: 160,
  dimension: 512,
  durationMs: 10_000,
  manifestBytes: 512 * 1024,
});

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const SAFE_ID_SOURCE = '[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?';
const SAFE_FILE_SOURCE = '[A-Za-z0-9][A-Za-z0-9._-]{0,95}';
const ALLOWED_PATH = new RegExp(
  `^(?:companion\\.json|collection\\.json|frames/${SAFE_FILE_SOURCE}\\.png|sounds/${SAFE_FILE_SOURCE}\\.wav|` +
  `companions/${SAFE_ID_SOURCE}/companion\\.json|companions/${SAFE_ID_SOURCE}/frames/${SAFE_FILE_SOURCE}\\.png|` +
  `companions/${SAFE_ID_SOURCE}/sounds/${SAFE_FILE_SOURCE}\\.wav)$`,
);
const SAFE_ID = new RegExp(`^${SAFE_ID_SOURCE}$`);
const SAFE_STATE = /^[a-z][a-z0-9-]{0,47}$/;
const SAFE_FRAME = new RegExp(`^frames/${SAFE_FILE_SOURCE}\\.png$`);
const SAFE_SOUND = new RegExp(`^sounds/${SAFE_FILE_SOURCE}\\.wav$`);
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
    fail('ARCHIVE_SIZE', 'Archive exceeds the 24 MiB limit.');
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
    if (total > PACK_LIMITS.uncompressedBytes) fail('UNCOMPRESSED_SIZE', 'Archive expands beyond 64 MiB.');
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

function requireInteger(value, code, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail(code);
  return number;
}

function optionalVector(value, code, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) fail(code);
  return value.map((part) => requireInteger(part, code, minimum, maximum));
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

function validateWav(bytes, path) {
  const ascii = (offset, value) => value.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.byteLength < 44 || !ascii(0, 'RIFF') || !ascii(8, 'WAVE')) {
    fail('INVALID_WAV', `${path} is not a PCM-compatible WAV file.`);
  }
}

function validateCompanionManifest(value, files, root = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_MANIFEST');
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) fail('SCHEMA_VERSION');
  const id = requireString(value.id, 'id', 48);
  if (!SAFE_ID.test(id)) fail('INVALID_ID', 'id must be a lowercase slug.');
  if (!value.name || typeof value.name !== 'object') fail('INVALID_NAME');
  const name = {
    en: requireString(value.name.en, 'name.en'),
    zh: requireString(value.name.zh, 'name.zh'),
  };
  const width = requireInteger(value.canvas?.width, 'INVALID_CANVAS', 16, PACK_LIMITS.dimension);
  const height = requireInteger(value.canvas?.height, 'INVALID_CANVAS', 16, PACK_LIMITS.dimension);
  const statesInput = value.states;
  if (!statesInput || typeof statesInput !== 'object' || Array.isArray(statesInput)) fail('INVALID_STATES');
  const stateEntries = Object.entries(statesInput);
  if (stateEntries.length < 1 || stateEntries.length > PACK_LIMITS.states) fail('STATE_COUNT');

  const referenced = new Set();
  const states = {};
  let frameReferences = 0;

  for (const [stateName, state] of stateEntries) {
    if (!SAFE_STATE.test(stateName) || !state || typeof state !== 'object') fail('INVALID_STATE');
    if (!Array.isArray(state.frames) || state.frames.length < 1 || state.frames.length > PACK_LIMITS.framesPerState) {
      fail('FRAME_COUNT');
    }
    const frames = state.frames.map((frame) => {
      const src = requireString(frame?.src, 'frame.src', 112);
      const fullPath = `${root}${src}`;
      if (!SAFE_FRAME.test(src) || !files[fullPath]) fail('MISSING_FRAME', `Missing referenced frame: ${fullPath}`);
      const durationMs = requireInteger(frame.durationMs, 'FRAME_DURATION', 40, PACK_LIMITS.durationMs);
      const dimensions = readPngSize(files[fullPath], fullPath);
      if (dimensions.width > width || dimensions.height > height) fail('FRAME_CANVAS', `${fullPath} is larger than the declared canvas.`);
      referenced.add(fullPath);
      frameReferences += 1;
      if (frameReferences > PACK_LIMITS.frameReferences) fail('FRAME_COUNT');
      const sanitized = { src, durationMs };
      const anchor = optionalVector(frame.anchor, 'INVALID_ANCHOR', 0, PACK_LIMITS.dimension);
      const velocity = optionalVector(frame.velocity, 'INVALID_VELOCITY', -64, 64);
      if (anchor) sanitized.anchor = anchor;
      if (velocity) sanitized.velocity = velocity;
      if (frame.sound !== undefined) {
        const sound = requireString(frame.sound, 'frame.sound', 112);
        const soundPath = `${root}${sound}`;
        if (!SAFE_SOUND.test(sound) || !files[soundPath]) fail('MISSING_SOUND', `Missing referenced sound: ${soundPath}`);
        validateWav(files[soundPath], soundPath);
        referenced.add(soundPath);
        sanitized.sound = sound;
        if (frame.volume !== undefined) sanitized.volume = requireInteger(frame.volume, 'INVALID_VOLUME', -60, 0);
      }
      return sanitized;
    });
    const sanitizedState = { loop: state.loop !== false, frames };
    if (typeof state.label === 'string') sanitizedState.label = requireString(state.label, 'state.label', 80);
    if (['stay', 'move', 'fall', 'climb', 'drag', 'sequence'].includes(state.motion)) sanitizedState.motion = state.motion;
    states[stateName] = sanitizedState;
  }

  const initialState = requireString(value.initialState, 'initialState', 48);
  if (!states[initialState]) fail('INITIAL_STATE');
  const behaviorPool = Array.isArray(value.behaviorPool)
    ? value.behaviorPool.map((choice) => {
        const state = requireString(choice?.state, 'behavior.state', 48);
        if (!states[state]) fail('INVALID_BEHAVIOR_STATE');
        return { state, weight: requireInteger(choice.weight, 'INVALID_BEHAVIOR_WEIGHT', 1, 10_000) };
      })
    : Object.keys(states).map((state) => ({ state, weight: 1 }));
  if (behaviorPool.length < 1 || behaviorPool.length > PACK_LIMITS.states) fail('BEHAVIOR_COUNT');

  const presentAssets = Object.keys(files).filter((path) =>
    path.startsWith(`${root}frames/`) || path.startsWith(`${root}sounds/`));
  if (presentAssets.some((path) => !referenced.has(path))) fail('UNREFERENCED_ASSET', 'Every frame and sound must be referenced.');

  return {
    manifest: {
      schemaVersion: value.schemaVersion,
      id,
      name,
      canvas: { width, height },
      initialState,
      states,
      behaviorPool,
    },
    referenced,
  };
}

export function validateManifest(value, files) {
  return validateCompanionManifest(value, files).manifest;
}

function parseJson(bytes, code = 'INVALID_JSON') {
  if (!bytes || bytes.byteLength > PACK_LIMITS.manifestBytes) fail('MANIFEST_SIZE');
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    fail(code);
  }
}

function validateCollection(value, files) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2) fail('SCHEMA_VERSION');
  const id = requireString(value.id, 'id', 48);
  if (!SAFE_ID.test(id)) fail('INVALID_ID');
  if (!value.name || typeof value.name !== 'object') fail('INVALID_NAME');
  const name = {
    en: requireString(value.name.en, 'name.en'),
    zh: requireString(value.name.zh, 'name.zh'),
  };
  const maxVisible = requireInteger(value.maxVisible ?? PACK_LIMITS.instances, 'INVALID_MAX_VISIBLE', 1, PACK_LIMITS.instances);
  const mobileMaxVisible = requireInteger(
    value.mobileMaxVisible ?? Math.min(maxVisible, 2),
    'INVALID_MOBILE_MAX_VISIBLE',
    1,
    PACK_LIMITS.mobileInstances,
  );
  if (!Array.isArray(value.companions) || value.companions.length < 1 || value.companions.length > PACK_LIMITS.companions) {
    fail('COMPANION_COUNT');
  }

  const companions = [];
  const ids = new Set();
  const referenced = new Set(['collection.json']);
  let desktopTotal = 0;
  let mobileTotal = 0;

  for (const entry of value.companions) {
    const companionId = requireString(entry?.id, 'companion.id', 48);
    if (!SAFE_ID.test(companionId) || ids.has(companionId)) fail('INVALID_COMPANION_ID');
    ids.add(companionId);
    const manifestPath = `companions/${companionId}/companion.json`;
    if (entry.manifest !== manifestPath || !files[manifestPath]) fail('MISSING_COMPANION_MANIFEST');
    const companion = validateCompanionManifest(parseJson(files[manifestPath]), files, `companions/${companionId}/`);
    if (companion.manifest.id !== companionId) fail('COMPANION_ID_MISMATCH');
    const enabled = entry.enabled !== false;
    const count = requireInteger(entry.count ?? 1, 'INVALID_INSTANCE_COUNT', 0, 4);
    const mobileCount = requireInteger(entry.mobileCount ?? Math.min(count, 1), 'INVALID_MOBILE_INSTANCE_COUNT', 0, 2);
    const scale = Number(entry.scale ?? 1);
    if (!Number.isFinite(scale) || scale < 0.4 || scale > 1.5) fail('INVALID_SCALE');
    const behavior = entry.behavior === 'click' ? 'click' : 'auto';
    if (enabled) {
      desktopTotal += count;
      mobileTotal += mobileCount;
    }
    referenced.add(manifestPath);
    companion.referenced.forEach((path) => referenced.add(path));
    companions.push({
      id: companionId,
      manifest: manifestPath,
      enabled,
      count,
      mobileCount,
      scale: Math.round(scale * 100) / 100,
      behavior,
    });
  }

  if (desktopTotal < 1 || desktopTotal > maxVisible || desktopTotal > PACK_LIMITS.instances) fail('INSTANCE_LIMIT');
  if (mobileTotal > mobileMaxVisible || mobileTotal > PACK_LIMITS.mobileInstances) fail('MOBILE_INSTANCE_LIMIT');
  if (Object.keys(files).some((path) => !referenced.has(path))) fail('UNREFERENCED_ASSET');

  return {
    schemaVersion: 2,
    id,
    name,
    maxVisible,
    mobileMaxVisible,
    companions,
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

  const hasCollection = Boolean(files['collection.json']);
  const hasCompanion = Boolean(files['companion.json']);
  if (hasCollection === hasCompanion) fail('MANIFEST_LAYOUT', 'Provide exactly one root manifest.');

  const sanitizedFiles = {};
  let manifest;
  let kind;
  let companionCount;
  let instanceCount;
  if (hasCollection) {
    manifest = validateCollection(parseJson(files['collection.json']), files);
    kind = 'collection';
    companionCount = manifest.companions.length;
    instanceCount = manifest.companions.reduce((total, companion) =>
      total + (companion.enabled ? companion.count : 0), 0);
    sanitizedFiles['collection.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of manifest.companions) {
      const root = `companions/${entry.id}/`;
      const nested = validateCompanionManifest(parseJson(files[entry.manifest]), files, root).manifest;
      sanitizedFiles[entry.manifest] = strToU8(`${JSON.stringify(nested, null, 2)}\n`);
      for (const state of Object.values(nested.states)) {
        for (const frame of state.frames) {
          sanitizedFiles[`${root}${frame.src}`] = files[`${root}${frame.src}`];
          if (frame.sound) sanitizedFiles[`${root}${frame.sound}`] = files[`${root}${frame.sound}`];
        }
      }
    }
  } else {
    manifest = validateCompanionManifest(parseJson(files['companion.json']), files).manifest;
    kind = 'companion';
    companionCount = 1;
    instanceCount = 1;
    sanitizedFiles['companion.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
    for (const state of Object.values(manifest.states)) {
      for (const frame of state.frames) {
        sanitizedFiles[frame.src] = files[frame.src];
        if (frame.sound) sanitizedFiles[frame.sound] = files[frame.sound];
      }
    }
  }

  const uniqueFrameCount = Object.keys(sanitizedFiles).filter((path) => path.endsWith('.png')).length;
  if (uniqueFrameCount > PACK_LIMITS.frames) fail('FRAME_COUNT');
  const sanitized = zipSync(sanitizedFiles, { level: 9, mtime: new Date('1980-01-02T00:00:00Z') });
  const sha256 = createHash('sha256').update(sanitized).digest('hex');
  return {
    bytes: sanitized,
    manifest,
    kind,
    sha256,
    version: sha256.slice(0, 16),
    frameCount: uniqueFrameCount,
    companionCount,
    instanceCount,
  };
}

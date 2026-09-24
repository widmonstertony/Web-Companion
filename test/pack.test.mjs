import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { PackValidationError, inspectZip, validateAndSanitizePack } from '../src/pack.mjs';

const PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+QkViWQAAAABJRU5ErkJggg==',
  'base64',
));

function archive(overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    id: 'blue-cat',
    name: { en: 'Blue Cat', zh: '蓝猫' },
    canvas: { width: 256, height: 256 },
    initialState: 'idle',
    states: { idle: { loop: true, frames: [{ src: 'frames/idle.png', durationMs: 160 }] } },
    ...overrides,
  };
  return zipSync({
    'companion.json': strToU8(JSON.stringify(manifest)),
    'frames/idle.png': PNG,
  });
}

test('accepts and deterministically sanitizes a valid pack', () => {
  const first = validateAndSanitizePack(archive());
  const second = validateAndSanitizePack(archive());
  assert.equal(first.manifest.id, 'blue-cat');
  assert.equal(first.frameCount, 1);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.version.length, 16);
});

test('rejects path traversal before decompression', () => {
  const bytes = zipSync({
    'companion.json': strToU8('{}'),
    '../evil.png': PNG,
  });
  assert.throws(() => inspectZip(bytes), (error) =>
    error instanceof PackValidationError && error.code === 'INVALID_PATH');
});

test('rejects missing frames and external frame URLs', () => {
  assert.throws(
    () => validateAndSanitizePack(archive({
      states: { idle: { frames: [{ src: 'https://example.com/frame.png', durationMs: 160 }] } },
    })),
    (error) => error instanceof PackValidationError && error.code === 'MISSING_FRAME',
  );
});

test('rejects unsafe timing and identifiers', () => {
  assert.throws(
    () => validateAndSanitizePack(archive({ id: '../cat' })),
    (error) => error instanceof PackValidationError && error.code === 'INVALID_ID',
  );
  assert.throws(
    () => validateAndSanitizePack(archive({
      states: { idle: { frames: [{ src: 'frames/idle.png', durationMs: 1 }] } },
    })),
    (error) => error instanceof PackValidationError && error.code === 'FRAME_DURATION',
  );
});

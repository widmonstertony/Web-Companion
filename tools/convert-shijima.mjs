#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { convertShijimaArchive } from '../public/shijima-import.js';
import { PACK_LIMITS, validateAndSanitizePack } from '../src/pack.mjs';

function usage() {
  console.error('Usage: npm run convert:shijima -- input.zip output.zip');
  process.exitCode = 2;
}

function inspectSourceZip(bytes) {
  if (bytes.byteLength < 22 || bytes.byteLength > PACK_LIMITS.archiveBytes) throw new Error('Input ZIP exceeds the 24 MiB limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Input is not a valid ZIP archive.');
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entries < 1 || entries > PACK_LIMITS.files || centralOffset + centralSize > eocd) throw new Error('Unsafe ZIP directory.');
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (uncompressed > PACK_LIMITS.fileBytes || (uncompressed > 1024 * 1024 && compressed > 0 && uncompressed / compressed > 100)) {
      throw new Error('Unsafe ZIP entry size or compression ratio.');
    }
    total += uncompressed;
    if (total > PACK_LIMITS.uncompressedBytes) throw new Error('Input ZIP expands beyond 64 MiB.');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  usage();
} else {
  const inputPath = resolve(inputArgument);
  const outputPath = resolve(outputArgument);
  const input = new Uint8Array(await readFile(inputPath));
  inspectSourceZip(input);
  const converted = convertShijimaArchive(unzipSync(input));
  const validated = validateAndSanitizePack(zipSync(converted.files, { level: 6 }));
  await writeFile(outputPath, validated.bytes, { flag: 'wx' });
  console.log(JSON.stringify({
    output: outputPath,
    companions: validated.companionCount,
    activeInstances: validated.instanceCount,
    frames: validated.frameCount,
    bytes: validated.bytes.byteLength,
    sha256: validated.sha256,
    skippedReferences: converted.warnings.length,
  }, null, 2));
}

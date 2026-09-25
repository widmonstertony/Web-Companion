const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attributes(source) {
  const result = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(pattern)) result[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  return result;
}

function slug(value, fallback) {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const result = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!result) return fallback;
  return /^[a-z]/.test(result) ? result : `item-${result}`;
}

function uniqueSlug(value, fallback, used) {
  const base = slug(value, fallback).slice(0, 42);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`.slice(0, 48).replace(/-+$/g, '');
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function basename(value) {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || '';
}

function safeAssetName(value, fallback, extension) {
  const raw = basename(value).replace(new RegExp(`\\.${extension}$`, 'i'), '');
  return `${slug(raw, fallback).slice(0, 88)}.${extension}`;
}

function pair(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part))) return undefined;
  return parts;
}

function pngDimensions(bytes) {
  if (!bytes || bytes.byteLength < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function motionFor(value = '') {
  const normalized = value.toLowerCase();
  if (normalized.includes('move') || value.includes('移動')) return 'move';
  if (normalized.includes('fall') || value.includes('落')) return 'fall';
  if (normalized.includes('drag') || value.includes('ドラッグ')) return 'drag';
  if (normalized.includes('sequence') || value.includes('複合')) return 'sequence';
  return 'stay';
}

function nativeDuration(value) {
  const ticks = Number(value);
  if (!Number.isFinite(ticks)) return 160;
  return Math.max(40, Math.min(10_000, Math.round(ticks * 40)));
}

function findMascotRoots(files) {
  return Object.keys(files)
    .filter((path) => /(?:^|\/)actions\.xml$/i.test(path) && path.includes('.mascot/'))
    .map((path) => path.slice(0, path.lastIndexOf('/')))
    .sort((left, right) => left.localeCompare(right));
}

function fileLookup(files, root, directory, extension) {
  const prefix = `${root}/${directory}/`;
  const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix) && path.toLowerCase().endsWith(`.${extension}`));
  const byName = new Map();
  for (const [path, bytes] of entries) {
    const name = basename(path).toLowerCase();
    if (!byName.has(name)) byName.set(name, { path, bytes });
  }
  return byName;
}

function parseBehaviors(xml) {
  const weights = new Map();
  const pattern = /<(?:Behavior|行動)(?=[\s/>])([^>]*)/gu;
  for (const match of xml.matchAll(pattern)) {
    const attrs = attributes(match[1]);
    const name = attrs.Name ?? attrs['名前'];
    const weight = Number(attrs.Frequency ?? attrs['頻度'] ?? 1);
    if (name && Number.isFinite(weight) && weight > 0) weights.set(name, Math.max(1, Math.min(10_000, Math.round(weight))));
  }
  return weights;
}

function convertMascot(files, root, id, displayName, warnings) {
  const actionBytes = files[`${root}/actions.xml`];
  if (!actionBytes) throw new Error(`Missing actions.xml for ${displayName}`);
  const actionXml = decoder.decode(actionBytes).replace(/^\uFEFF/, '');
  const behaviorXml = files[`${root}/behaviors.xml`]
    ? decoder.decode(files[`${root}/behaviors.xml`]).replace(/^\uFEFF/, '')
    : '';
  const images = fileLookup(files, root, 'img', 'png');
  const sounds = fileLookup(files, root, 'sound', 'wav');
  const behaviorWeights = parseBehaviors(behaviorXml);
  const usedStates = new Set();
  const usedFrames = new Map();
  const usedSounds = new Map();
  const states = {};
  const labelToState = new Map();
  let maxWidth = 16;
  let maxHeight = 16;
  let actionIndex = 0;

  const actionPattern = /<(Action|動作)(?=[\s/>])([^>]*)>([\s\S]*?)<\/\1>/gu;
  for (const actionMatch of actionXml.matchAll(actionPattern)) {
    actionIndex += 1;
    const actionAttrs = attributes(actionMatch[2]);
    const label = actionAttrs.Name ?? actionAttrs['名前'] ?? `Action ${actionIndex}`;
    const frames = [];
    const posePattern = /<(?:Pose|ポーズ)(?=[\s/>])([^>]*)\/?\s*>/gu;
    for (const poseMatch of actionMatch[3].matchAll(posePattern)) {
      const pose = attributes(poseMatch[1]);
      const imageReference = pose.Image ?? pose['画像'];
      const imageSource = images.get(basename(imageReference ?? '').toLowerCase());
      if (!imageReference || !imageSource) {
        if (imageReference) warnings.push(`${displayName}: skipped missing frame ${basename(imageReference)}`);
        continue;
      }
      let outputFrame = usedFrames.get(imageSource.path);
      if (!outputFrame) {
        outputFrame = safeAssetName(imageReference, `frame-${usedFrames.size + 1}`, 'png');
        const taken = new Set(usedFrames.values());
        let suffix = 2;
        const stem = outputFrame.slice(0, -4);
        while (taken.has(outputFrame)) {
          outputFrame = `${stem}-${suffix}.png`;
          suffix += 1;
        }
        usedFrames.set(imageSource.path, outputFrame);
        const dimensions = pngDimensions(imageSource.bytes);
        if (dimensions) {
          maxWidth = Math.max(maxWidth, dimensions.width);
          maxHeight = Math.max(maxHeight, dimensions.height);
        }
      }
      const frame = {
        src: `frames/${outputFrame}`,
        durationMs: nativeDuration(pose.Duration ?? pose['長さ']),
      };
      const anchor = pair(pose.ImageAnchor ?? pose['基準座標']);
      const velocity = pair(pose.Velocity ?? pose['移動速度']);
      if (anchor?.every((part) => part >= 0 && part <= 512)) frame.anchor = anchor;
      if (velocity?.every((part) => part >= -64 && part <= 64)) frame.velocity = velocity;

      const soundReference = pose.Sound ?? pose['音'];
      const soundSource = sounds.get(basename(soundReference ?? '').toLowerCase());
      if (soundReference && soundSource) {
        let outputSound = usedSounds.get(soundSource.path);
        if (!outputSound) {
          outputSound = safeAssetName(soundReference, `sound-${usedSounds.size + 1}`, 'wav');
          const taken = new Set(usedSounds.values());
          let suffix = 2;
          const stem = outputSound.slice(0, -4);
          while (taken.has(outputSound)) {
            outputSound = `${stem}-${suffix}.wav`;
            suffix += 1;
          }
          usedSounds.set(soundSource.path, outputSound);
        }
        frame.sound = `sounds/${outputSound}`;
        const volume = Number(pose.Volume ?? pose['音量'] ?? 0);
        if (Number.isInteger(volume)) frame.volume = Math.max(-60, Math.min(0, volume));
      }
      frames.push(frame);
    }
    if (frames.length === 0) continue;
    const stateName = uniqueSlug(label, `action-${actionIndex}`, usedStates);
    states[stateName] = {
      label: label.slice(0, 80),
      loop: true,
      motion: motionFor(actionAttrs.Type ?? actionAttrs['種類']),
      frames: frames.slice(0, 128),
    };
    labelToState.set(label, stateName);
  }

  const stateNames = Object.keys(states);
  if (stateNames.length === 0) throw new Error(`${displayName} has no importable animated actions.`);
  const behaviorPool = [];
  for (const [label, weight] of behaviorWeights) {
    const state = labelToState.get(label);
    if (state && !behaviorPool.some((choice) => choice.state === state)) behaviorPool.push({ state, weight });
  }
  if (behaviorPool.length === 0) stateNames.forEach((state) => behaviorPool.push({ state, weight: 1 }));
  const initialState = labelToState.get('Stand') ?? labelToState.get('立つ') ?? stateNames[0];
  const manifest = {
    schemaVersion: 2,
    id,
    name: { en: displayName.slice(0, 80), zh: displayName.slice(0, 80) },
    canvas: { width: maxWidth, height: maxHeight },
    initialState,
    states,
    behaviorPool,
  };
  const outputFiles = {};
  for (const [sourcePath, outputName] of usedFrames) outputFiles[`companions/${id}/frames/${outputName}`] = files[sourcePath];
  for (const [sourcePath, outputName] of usedSounds) outputFiles[`companions/${id}/sounds/${outputName}`] = files[sourcePath];
  outputFiles[`companions/${id}/companion.json`] = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, outputFiles };
}

export function isShijimaArchive(files) {
  return findMascotRoots(files).length > 0;
}

export function convertShijimaArchive(files) {
  const roots = findMascotRoots(files);
  if (roots.length === 0) throw new Error('No .mascot directories with actions.xml were found.');
  if (roots.length > 12) throw new Error('A collection may contain at most 12 mascots.');
  const usedIds = new Set();
  const outputFiles = {};
  const warnings = [];
  const companions = [];

  for (const [index, root] of roots.entries()) {
    const directoryName = root.split('/').at(-1).replace(/\.mascot$/i, '');
    const id = uniqueSlug(directoryName, `mascot-${index + 1}`, usedIds);
    const converted = convertMascot(files, root, id, directoryName, warnings);
    Object.assign(outputFiles, converted.outputFiles);
    companions.push({
      id,
      manifest: `companions/${id}/companion.json`,
      enabled: true,
      count: index === 0 ? 1 : 0,
      mobileCount: index === 0 ? 1 : 0,
      scale: 1,
      behavior: 'auto',
    });
  }

  const collection = {
    schemaVersion: 2,
    id: 'shijima-collection',
    name: { en: 'Shijima Collection', zh: 'Shijima 角色集' },
    maxVisible: 8,
    mobileMaxVisible: 2,
    companions,
  };
  outputFiles['collection.json'] = encoder.encode(`${JSON.stringify(collection, null, 2)}\n`);
  return { files: outputFiles, collection, warnings };
}

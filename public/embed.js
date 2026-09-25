import { strFromU8, unzipSync } from '/companion/vendor/fflate.js';

const DEFAULT_MANIFEST = 'https://raw.githubusercontent.com/widmonstertony/Web-Companion-Assets/media/manifest.json';
const manifestUrl = new URLSearchParams(window.location.search).get('manifest') || DEFAULT_MANIFEST;
const stage = document.querySelector('.companion-stage');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const objectUrls = [];
const instances = [];
let soundUnlocked = false;

function notifyParent(active, detail = {}) {
  window.parent?.postMessage({ type: 'tonytan:companion-ready', active, ...detail }, '*');
}

function safeAssetPath(value, kind) {
  const extension = kind === 'frame' ? 'png' : 'wav';
  const directory = kind === 'frame' ? 'frames' : 'sounds';
  return typeof value === 'string' && new RegExp(`^${directory}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\\.${extension}$`).test(value);
}

function safeRoot(value) {
  return typeof value === 'string' && /^companions\/[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?\/$/.test(value);
}

function validateCompanion(manifest, files, root = '') {
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || typeof manifest.id !== 'string') throw new Error('Invalid companion');
  if (root && !safeRoot(root)) throw new Error('Invalid companion root');
  if (!manifest.states || !manifest.states[manifest.initialState]) throw new Error('Invalid states');
  for (const state of Object.values(manifest.states)) {
    if (!Array.isArray(state.frames) || state.frames.length < 1 || state.frames.length > 128) throw new Error('Invalid frames');
    for (const frame of state.frames) {
      if (!safeAssetPath(frame.src, 'frame') || !files[`${root}${frame.src}`]) throw new Error('Missing frame');
      if (!Number.isInteger(frame.durationMs) || frame.durationMs < 40 || frame.durationMs > 10_000) throw new Error('Invalid timing');
      if (frame.sound && (!safeAssetPath(frame.sound, 'sound') || !files[`${root}${frame.sound}`])) throw new Error('Missing sound');
    }
  }
  return manifest;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function objectUrl(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  objectUrls.push(url);
  return url;
}

function chooseWeighted(manifest) {
  const available = Array.isArray(manifest.behaviorPool)
    ? manifest.behaviorPool.filter((choice) => manifest.states[choice.state] && Number(choice.weight) > 0)
    : [];
  const pool = available.length > 0
    ? available
    : Object.keys(manifest.states).map((state) => ({ state, weight: 1 }));
  const total = pool.reduce((sum, choice) => sum + Number(choice.weight), 0);
  let cursor = Math.random() * total;
  for (const choice of pool) {
    cursor -= Number(choice.weight);
    if (cursor <= 0) return choice.state;
  }
  return pool.at(-1).state;
}

function playFrameSound(instance, frame) {
  if (!soundUnlocked || !frame.sound) return;
  const url = instance.urls[frame.sound];
  if (!url) return;
  const audio = new Audio(url);
  audio.volume = frame.volume === undefined ? 0.7 : Math.max(0, Math.min(1, 10 ** (frame.volume / 20)));
  audio.play().catch(() => {});
}

function applyMotion(instance, frame) {
  if (!Array.isArray(frame.velocity) || instance.dragging || reducedMotion.matches) return;
  const [velocityX, velocityY] = frame.velocity;
  const rect = instance.button.getBoundingClientRect();
  const horizontalLimit = Math.max(0, rect.width * 0.3);
  const verticalLimit = Math.max(0, rect.height * 0.42);
  const ticks = frame.durationMs / 40;
  let nextX = instance.x + velocityX * instance.facing * ticks * 0.18;
  if (nextX < -horizontalLimit || nextX > horizontalLimit) {
    instance.facing *= -1;
    nextX = Math.max(-horizontalLimit, Math.min(horizontalLimit, instance.x + velocityX * instance.facing * ticks * 0.18));
  }
  instance.x = Math.max(-horizontalLimit, Math.min(horizontalLimit, nextX));
  instance.y = Math.max(-verticalLimit, Math.min(0, instance.y + velocityY * ticks * 0.12));
  instance.image.style.setProperty('--companion-x', `${instance.x}px`);
  instance.image.style.setProperty('--companion-y', `${instance.y}px`);
  instance.image.style.setProperty('--companion-facing', String(instance.facing));
}

function stopInstance(instance) {
  window.clearTimeout(instance.timer);
  instance.timer = undefined;
}

function showFrame(instance) {
  stopInstance(instance);
  const state = instance.manifest.states[instance.stateName];
  const frame = state.frames[instance.frameIndex] ?? state.frames[0];
  instance.image.src = instance.urls[frame.src];
  playFrameSound(instance, frame);
  applyMotion(instance, frame);
  if (reducedMotion.matches) return;
  instance.timer = window.setTimeout(() => {
    const atEnd = instance.frameIndex >= state.frames.length - 1;
    if (!atEnd) {
      instance.frameIndex += 1;
    } else if (instance.behavior === 'auto') {
      instance.stateName = chooseWeighted(instance.manifest);
      instance.frameIndex = 0;
    } else if (state.loop !== false) {
      instance.frameIndex = 0;
    } else {
      return;
    }
    showFrame(instance);
  }, frame.durationMs);
}

function chooseNextState(instance) {
  const states = Object.keys(instance.manifest.states);
  if (states.length < 2) return;
  const current = states.indexOf(instance.stateName);
  instance.stateName = states[(current + 1) % states.length];
  instance.frameIndex = 0;
  showFrame(instance);
}

function installDragging(instance) {
  let start;
  let moved = false;
  instance.button.addEventListener('pointerdown', (event) => {
    soundUnlocked = true;
    instance.dragging = true;
    moved = false;
    start = { pointerX: event.clientX, pointerY: event.clientY, x: instance.x, y: instance.y };
    instance.button.setPointerCapture(event.pointerId);
  });
  instance.button.addEventListener('pointermove', (event) => {
    if (!instance.dragging || !start) return;
    const dx = event.clientX - start.pointerX;
    const dy = event.clientY - start.pointerY;
    moved ||= Math.abs(dx) + Math.abs(dy) > 6;
    const rect = instance.button.getBoundingClientRect();
    instance.x = Math.max(-rect.width * 0.45, Math.min(rect.width * 0.45, start.x + dx));
    instance.y = Math.max(-rect.height * 0.65, Math.min(0, start.y + dy));
    instance.image.style.setProperty('--companion-x', `${instance.x}px`);
    instance.image.style.setProperty('--companion-y', `${instance.y}px`);
  });
  const release = (event) => {
    if (!instance.dragging) return;
    instance.dragging = false;
    instance.button.releasePointerCapture?.(event.pointerId);
    if (!moved) chooseNextState(instance);
  };
  instance.button.addEventListener('pointerup', release);
  instance.button.addEventListener('pointercancel', release);
  instance.button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    soundUnlocked = true;
    chooseNextState(instance);
  });
}

function createInstance(manifest, root, urls, settings, sequence) {
  const button = document.createElement('button');
  const image = document.createElement('img');
  button.className = 'companion-instance';
  button.type = 'button';
  button.setAttribute('aria-label', `${manifest.name.en} ${sequence}`);
  button.style.setProperty('--companion-scale', String(settings.scale ?? 1));
  image.alt = '';
  image.draggable = false;
  button.append(image);
  stage.append(button);
  const instance = {
    button,
    image,
    manifest,
    root,
    urls,
    behavior: settings.behavior,
    stateName: manifest.initialState,
    frameIndex: 0,
    timer: undefined,
    x: 0,
    y: 0,
    facing: Math.random() > 0.5 ? 1 : -1,
    dragging: false,
  };
  image.style.setProperty('--companion-facing', String(instance.facing));
  installDragging(instance);
  instances.push(instance);
  showFrame(instance);
}

function loadCompanionUrls(files, root, manifest) {
  const urls = {};
  const referenced = new Set();
  for (const state of Object.values(manifest.states)) {
    for (const frame of state.frames) {
      referenced.add(frame.src);
      if (frame.sound) referenced.add(frame.sound);
    }
  }
  for (const path of referenced) {
    const bytes = files[`${root}${path}`];
    urls[path] = objectUrl(bytes, path.endsWith('.png') ? 'image/png' : 'audio/wav');
  }
  return urls;
}

function isMobileHost() {
  const width = screen.width || 1024;
  const shortSide = Math.min(width, screen.height || 1024);
  return width <= 760 || (window.matchMedia('(pointer: coarse)').matches && shortSide <= 1024);
}

function loadCollection(collection, files) {
  if (!collection || collection.schemaVersion !== 2 || !Array.isArray(collection.companions)) throw new Error('Invalid collection');
  const mobile = isMobileHost();
  const maximum = mobile ? collection.mobileMaxVisible : collection.maxVisible;
  let visible = 0;
  for (const entry of collection.companions) {
    if (!entry.enabled || visible >= maximum) continue;
    const root = `companions/${entry.id}/`;
    if (!safeRoot(root) || entry.manifest !== `${root}companion.json`) throw new Error('Invalid collection entry');
    const manifest = validateCompanion(JSON.parse(strFromU8(files[entry.manifest])), files, root);
    const urls = loadCompanionUrls(files, root, manifest);
    const requested = mobile ? entry.mobileCount : entry.count;
    const count = Math.max(0, Math.min(4, Number(requested) || 0, maximum - visible));
    for (let index = 0; index < count; index += 1) createInstance(manifest, root, urls, entry, index + 1);
    visible += count;
  }
  if (visible < 1) throw new Error('Collection has no visible companions');
  return visible;
}

async function load() {
  try {
    const manifestResponse = await fetch(manifestUrl, { cache: 'no-store', credentials: 'omit' });
    if (!manifestResponse.ok) throw new Error('Manifest unavailable');
    const publicManifest = await manifestResponse.json();
    if (![1, 2].includes(publicManifest.schemaVersion) || !publicManifest.active) {
      notifyParent(false);
      return;
    }
    const active = publicManifest.active;
    if (!/^https:\/\//.test(active.packUrl) && !active.packUrl.startsWith('/')) throw new Error('Invalid pack URL');
    const packResponse = await fetch(active.packUrl, { cache: 'force-cache', credentials: 'omit' });
    if (!packResponse.ok) throw new Error('Pack unavailable');
    const bytes = new Uint8Array(await packResponse.arrayBuffer());
    if (bytes.byteLength > 24 * 1024 * 1024) throw new Error('Pack too large');
    if (active.sha256 && await sha256Hex(bytes) !== active.sha256) throw new Error('Pack integrity mismatch');
    const files = unzipSync(bytes);
    let count;
    if (files['collection.json']) {
      count = loadCollection(JSON.parse(strFromU8(files['collection.json'])), files);
      stage.setAttribute('aria-label', active.name?.en || 'Animated companions');
    } else {
      const manifest = validateCompanion(JSON.parse(strFromU8(files['companion.json'])), files);
      createInstance(manifest, '', loadCompanionUrls(files, '', manifest), { scale: 1, behavior: 'auto' }, 1);
      count = 1;
      stage.setAttribute('aria-label', active.name?.en || manifest.name.en || 'Animated companion');
    }
    stage.hidden = false;
    notifyParent(true, { id: active.id, version: active.version, companionCount: count });
  } catch (error) {
    console.warn('Web Companion could not load:', error instanceof Error ? error.message : error);
    notifyParent(false, { error: 'LOAD_FAILED' });
  }
}

reducedMotion.addEventListener?.('change', () => instances.forEach(showFrame));
window.addEventListener('pagehide', () => {
  instances.forEach(stopInstance);
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
});

load();

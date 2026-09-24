import { strFromU8, unzipSync } from '/companion/vendor/fflate.js';

const DEFAULT_MANIFEST = 'https://raw.githubusercontent.com/widmonstertony/Web-Companion-Assets/media/manifest.json';
const manifestUrl = new URLSearchParams(window.location.search).get('manifest') || DEFAULT_MANIFEST;
const stage = document.querySelector('.companion-stage');
const image = stage.querySelector('img');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const objectUrls = [];
let animationTimer;
let pack;
let stateName;
let frameIndex = 0;

function notifyParent(active, detail = {}) {
  window.parent?.postMessage({ type: 'tonytan:companion-ready', active, ...detail }, '*');
}

function safePackPath(value) {
  return typeof value === 'string' && /^frames\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.png$/.test(value);
}

function validateRuntimePack(manifest, files) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.id !== 'string') throw new Error('Invalid pack');
  if (!manifest.states || !manifest.states[manifest.initialState]) throw new Error('Invalid states');
  for (const state of Object.values(manifest.states)) {
    if (!Array.isArray(state.frames) || state.frames.length < 1) throw new Error('Invalid frames');
    for (const frame of state.frames) {
      if (!safePackPath(frame.src) || !files[frame.src]) throw new Error('Missing frame');
      if (!Number.isInteger(frame.durationMs) || frame.durationMs < 40 || frame.durationMs > 2000) {
        throw new Error('Invalid timing');
      }
    }
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function clearAnimation() {
  window.clearTimeout(animationTimer);
  animationTimer = undefined;
}

function showFrame() {
  clearAnimation();
  const state = pack.manifest.states[stateName];
  const frame = state.frames[frameIndex] ?? state.frames[0];
  image.src = pack.urls[frame.src];
  if (reducedMotion.matches) return;
  animationTimer = window.setTimeout(() => {
    const atEnd = frameIndex >= state.frames.length - 1;
    frameIndex = atEnd ? (state.loop === false ? frameIndex : 0) : frameIndex + 1;
    if (!atEnd || state.loop !== false) showFrame();
  }, frame.durationMs);
}

function chooseNextState() {
  const states = Object.keys(pack.manifest.states);
  if (states.length < 2) return;
  const current = states.indexOf(stateName);
  stateName = states[(current + 1) % states.length];
  frameIndex = 0;
  showFrame();
}

async function load() {
  try {
    const manifestResponse = await fetch(manifestUrl, { cache: 'no-store', credentials: 'omit' });
    if (!manifestResponse.ok) throw new Error('Manifest unavailable');
    const publicManifest = await manifestResponse.json();
    if (publicManifest.schemaVersion !== 1 || !publicManifest.active) {
      notifyParent(false);
      return;
    }
    const active = publicManifest.active;
    if (!/^https:\/\//.test(active.packUrl) && !active.packUrl.startsWith('/')) throw new Error('Invalid pack URL');
    const packResponse = await fetch(active.packUrl, { cache: 'force-cache', credentials: 'omit' });
    if (!packResponse.ok) throw new Error('Pack unavailable');
    const bytes = new Uint8Array(await packResponse.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Pack too large');
    if (active.sha256 && await sha256Hex(bytes) !== active.sha256) throw new Error('Pack integrity mismatch');
    const files = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(files['companion.json']));
    validateRuntimePack(manifest, files);
    const urls = {};
    for (const [path, fileBytes] of Object.entries(files)) {
      if (!path.startsWith('frames/')) continue;
      const url = URL.createObjectURL(new Blob([fileBytes], { type: 'image/png' }));
      objectUrls.push(url);
      urls[path] = url;
    }
    pack = { manifest, urls };
    stateName = manifest.initialState;
    stage.hidden = false;
    stage.setAttribute('aria-label', active.name?.en || manifest.name.en || 'Animated companion');
    showFrame();
    notifyParent(true, { id: manifest.id, version: active.version });
  } catch (error) {
    console.warn('Web Companion could not load:', error instanceof Error ? error.message : error);
    notifyParent(false, { error: 'LOAD_FAILED' });
  }
}

stage.addEventListener('click', chooseNextState);
reducedMotion.addEventListener?.('change', showFrame);
window.addEventListener('pagehide', () => {
  clearAnimation();
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
});

load();

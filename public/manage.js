import { strFromU8, strToU8, unzipSync, zipSync } from '/companion/vendor/fflate.js';
import { convertShijimaArchive, isShijimaArchive } from '/companion/shijima-import.js';

const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const authCard = document.querySelector('.auth-card');
const status = authCard.querySelector('.status');
const login = authCard.querySelector('.login');
const form = document.querySelector('.publish-card');
const input = form.querySelector('#pack');
const progress = form.querySelector('progress');
const output = form.querySelector('output');
const editor = form.querySelector('.collection-editor');
const characterList = form.querySelector('.character-list');
const desktopLimit = form.querySelector('.desktop-limit');
const mobileLimit = form.querySelector('.mobile-limit');
const summary = form.querySelector('.collection-summary');
const warningBox = form.querySelector('.import-warnings');
const rights = form.querySelector('[name="rights"]');
const publishButton = form.querySelector('button[type="submit"]');
let csrfToken = '';
let draft = null;
let previewUrls = [];

function findEndOfDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floor = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('INVALID_ZIP');
}

function assertSafeArchive(bytes) {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ARCHIVE_SIZE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfDirectory(bytes);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entries < 1 || entries > 1024 || centralOffset + centralSize > eocd) throw new Error('FILE_COUNT');
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('INVALID_ZIP');
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (uncompressed > 4 * 1024 * 1024 || (uncompressed > 1024 * 1024 && compressed > 0 && uncompressed / compressed > 100)) {
      throw new Error('UNSAFE_ARCHIVE');
    }
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('UNCOMPRESSED_SIZE');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function friendlyError(code) {
  const messages = {
    ARCHIVE_SIZE: 'The ZIP must be smaller than 24 MiB.',
    FILE_COUNT: 'The ZIP contains too many files.',
    UNCOMPRESSED_SIZE: 'The ZIP expands beyond the safe 64 MiB limit.',
    UNSAFE_ARCHIVE: 'The ZIP contains an unsafe or oversized entry.',
    INVALID_ZIP: 'The selected file is not a valid ZIP archive.',
    INSTANCE_LIMIT: 'Desktop character counts exceed the selected maximum.',
    MOBILE_INSTANCE_LIMIT: 'Mobile character counts exceed the selected maximum.',
    RIGHTS_REQUIRED: 'Confirm publication rights before publishing.',
  };
  return messages[code] || code || 'UNKNOWN_ERROR';
}

async function loadSession() {
  try {
    const response = await fetch('/companion/api/session', { credentials: 'same-origin' });
    const session = await response.json();
    if (!session.authenticated) {
      status.textContent = 'Sign in with the site owner GitHub account to publish.';
      login.hidden = false;
      authCard.dataset.authState = 'anonymous';
      return;
    }
    csrfToken = session.csrfToken;
    status.textContent = 'Administrator verified.';
    form.hidden = false;
    authCard.dataset.authState = 'authenticated';
  } catch {
    status.textContent = 'The publisher is temporarily unavailable.';
    authCard.dataset.authState = 'error';
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function companionDetails(entry, files) {
  const manifest = files[entry.manifest] ? parseJson(files[entry.manifest], entry.manifest) : null;
  return { manifest, name: manifest?.name?.en || entry.id };
}

function clearPreviews() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
}

function numberInput(label, className, minimum, maximum, step, value) {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  const field = document.createElement('input');
  field.className = className;
  field.type = 'number';
  field.min = String(minimum);
  field.max = String(maximum);
  field.step = String(step);
  field.value = String(value);
  wrapper.append(field);
  return wrapper;
}

function updateSummary() {
  if (!draft?.collection) return;
  const desktop = [...characterList.querySelectorAll('.character-card')].reduce((total, card) =>
    total + (card.querySelector('.character-enabled input').checked ? Number(card.querySelector('.desktop-count').value) || 0 : 0), 0);
  const mobile = [...characterList.querySelectorAll('.character-card')].reduce((total, card) =>
    total + (card.querySelector('.character-enabled input').checked ? Number(card.querySelector('.mobile-count').value) || 0 : 0), 0);
  summary.textContent = `${draft.collection.companions.length} characters · ${desktop} desktop · ${mobile} mobile`;
}

function renderCollection() {
  clearPreviews();
  characterList.replaceChildren();
  const collection = draft.collection;
  desktopLimit.value = String(collection.maxVisible ?? 8);
  mobileLimit.value = String(collection.mobileMaxVisible ?? 2);
  for (const entry of collection.companions) {
    const card = document.createElement('article');
    card.className = 'character-card';
    card.dataset.id = entry.id;

    const name = document.createElement('div');
    name.className = 'character-name';
    const details = companionDetails(entry, draft.files);
    const firstFrame = details.manifest?.states?.[details.manifest.initialState]?.frames?.[0]?.src;
    const root = entry.manifest.slice(0, entry.manifest.lastIndexOf('/') + 1);
    if (firstFrame && draft.files[`${root}${firstFrame}`]) {
      const preview = document.createElement('img');
      const previewUrl = URL.createObjectURL(new Blob([draft.files[`${root}${firstFrame}`]], { type: 'image/png' }));
      previewUrls.push(previewUrl);
      preview.src = previewUrl;
      preview.alt = '';
      preview.className = 'character-preview';
      name.append(preview);
    }
    const nameCopy = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = details.name;
    const small = document.createElement('small');
    small.textContent = entry.id;
    nameCopy.append(strong, small);
    name.append(nameCopy);

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'character-enabled';
    enabledLabel.textContent = 'Enabled';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = entry.enabled !== false;
    enabledLabel.append(enabled);

    const desktop = numberInput('Desktop count', 'desktop-count', 0, 4, 1, entry.count ?? 1);
    const mobile = numberInput('Mobile count', 'mobile-count', 0, 2, 1, entry.mobileCount ?? Math.min(entry.count ?? 1, 1));
    const scale = numberInput('Scale', 'character-scale', 0.4, 1.5, 0.05, entry.scale ?? 1);

    const behaviorLabel = document.createElement('label');
    behaviorLabel.textContent = 'Behavior';
    const behavior = document.createElement('select');
    behavior.className = 'character-behavior';
    for (const [value, text] of [['auto', 'Automatic'], ['click', 'Click only']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = (entry.behavior ?? 'auto') === value;
      behavior.append(option);
    }
    behaviorLabel.append(behavior);
    card.append(name, enabledLabel, desktop, mobile, scale, behaviorLabel);
    characterList.append(card);
  }
  editor.hidden = false;
  updateSummary();
}

function applyCollectionControls() {
  const collection = structuredClone(draft.collection);
  collection.maxVisible = Number(desktopLimit.value);
  collection.mobileMaxVisible = Number(mobileLimit.value);
  let desktopTotal = 0;
  let mobileTotal = 0;
  collection.companions = collection.companions.map((entry) => {
    const card = characterList.querySelector(`[data-id="${CSS.escape(entry.id)}"]`);
    const enabled = card.querySelector('.character-enabled input').checked;
    const count = Number(card.querySelector('.desktop-count').value);
    const mobileCount = Number(card.querySelector('.mobile-count').value);
    if (enabled) {
      desktopTotal += count;
      mobileTotal += mobileCount;
    }
    return {
      ...entry,
      enabled,
      count,
      mobileCount,
      scale: Number(card.querySelector('.character-scale').value),
      behavior: card.querySelector('.character-behavior').value,
    };
  });
  if (desktopTotal < 1 || desktopTotal > collection.maxVisible || desktopTotal > 8) throw new Error('INSTANCE_LIMIT');
  if (mobileTotal > collection.mobileMaxVisible || mobileTotal > 4) throw new Error('MOBILE_INSTANCE_LIMIT');
  return collection;
}

async function prepareFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertSafeArchive(bytes);
  const files = unzipSync(bytes);
  if (isShijimaArchive(files)) {
    const converted = convertShijimaArchive(files);
    draft = { bytes, files: converted.files, collection: converted.collection, converted: true };
    warningBox.hidden = converted.warnings.length === 0;
    warningBox.textContent = converted.warnings.length > 0
      ? `${converted.warnings.length} missing native frame references were skipped. Other valid actions remain available.`
      : '';
    renderCollection();
    output.textContent = `Imported ${converted.collection.companions.length} native Shijima characters locally. Nothing has been uploaded yet.`;
    return;
  }
  if (files['collection.json']) {
    const collection = parseJson(files['collection.json'], 'collection.json');
    draft = { bytes, files, collection, converted: false };
    warningBox.hidden = true;
    renderCollection();
    output.textContent = `Loaded ${collection.companions?.length ?? 0} collection characters. Nothing has been uploaded yet.`;
    return;
  }
  if (files['companion.json']) {
    draft = { bytes, files, collection: null, converted: false };
    editor.hidden = true;
    warningBox.hidden = true;
    output.textContent = 'Loaded one legacy Companion pack. Nothing has been uploaded yet.';
    return;
  }
  throw new Error('No Shijima mascots, collection.json, or companion.json were found.');
}

input.addEventListener('change', async () => {
  clearPreviews();
  draft = null;
  editor.hidden = true;
  warningBox.hidden = true;
  rights.checked = false;
  output.textContent = '';
  const file = input.files?.[0];
  if (!file) return;
  publishButton.disabled = true;
  progress.hidden = false;
  progress.removeAttribute('value');
  try {
    await prepareFile(file);
  } catch (error) {
    input.value = '';
    output.textContent = `Could not read this archive: ${friendlyError(error instanceof Error ? error.message : 'UNKNOWN_ERROR')}`;
  } finally {
    progress.hidden = true;
    publishButton.disabled = false;
  }
});

editor.addEventListener('input', updateSummary);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!draft) return;
  if (!rights.checked) {
    output.textContent = friendlyError('RIGHTS_REQUIRED');
    rights.focus();
    return;
  }
  output.textContent = '';
  progress.hidden = false;
  progress.removeAttribute('value');
  publishButton.disabled = true;
  try {
    let body = draft.bytes;
    if (draft.collection) {
      const collection = applyCollectionControls();
      const files = { ...draft.files, 'collection.json': strToU8(`${JSON.stringify(collection, null, 2)}\n`) };
      body = zipSync(files, { level: 6 });
      if (body.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ARCHIVE_SIZE');
    }
    const response = await fetch('/companion/api/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/zip',
        'X-CSRF-Token': csrfToken,
      },
      body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `HTTP_${response.status}`);
    progress.value = 100;
    output.textContent = `${payload.name} is live with ${payload.instanceCount} visible companion${payload.instanceCount === 1 ? '' : 's'}.`;
    input.value = '';
    rights.checked = false;
    draft = null;
  } catch (error) {
    progress.hidden = true;
    output.textContent = `Publish failed: ${friendlyError(error instanceof Error ? error.message : 'UNKNOWN_ERROR')}`;
  } finally {
    publishButton.disabled = false;
  }
});

loadSession();
window.addEventListener('pagehide', clearPreviews);

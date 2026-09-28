const $ = (id) => document.getElementById(id);
const MAX_FILE_SIZE = 200 * 1024 * 1024;
const RAW_EXTENSIONS = new Set('3fr arw cr2 cr3 dcr dng fff iiq kdc mos mrw nef nrw orf pef ptx raf raw rw2 rwl sr2 srf srw'.split(' '));
const TERMINAL = new Set(['completed', 'error']);
const ACTIVE = new Set(['preparing', 'running']);
const STATUS_LABELS = {
  preparing: 'PREPARING', running: 'EDIT IN PROGRESS', pausing: 'PAUSING',
  paused: 'PAUSED', awaiting_answer: 'YOUR PERSPECTIVE', awaiting_choice: 'YOUR CHOICE',
  completed: 'SESSION COMPLETE', error: 'NEEDS ATTENTION',
};
const ADJUSTMENT_DISPLAY = {
  Exposure2012: ['Exposure', ' EV', true],
  Contrast2012: ['Contrast', '', true],
  Highlights2012: ['Highlights', '', true],
  Shadows2012: ['Shadows', '', true],
  Whites2012: ['Whites', '', true],
  Blacks2012: ['Blacks', '', true],
  Clarity2012: ['Clarity', '', true],
  Texture: ['Texture', '', true],
  Dehaze: ['Dehaze', '', true],
  Vibrance: ['Vibrance', '', true],
  Saturation: ['Saturation', '', true],
  Temperature: ['White balance', ' K'],
  Tint: ['Tint', '', true],
  Sharpness: ['Sharpening'],
  SharpenRadius: ['Sharpening radius'],
  SharpenDetail: ['Sharpening detail'],
  SharpenEdgeMasking: ['Sharpening masking'],
  LuminanceSmoothing: ['Luminance noise reduction'],
  LuminanceNoiseReductionDetail: ['Luminance detail'],
  LuminanceNoiseReductionContrast: ['Luminance contrast'],
  ColorNoiseReduction: ['Color noise reduction'],
  ColorNoiseReductionDetail: ['Color detail'],
  ColorNoiseReductionSmoothness: ['Color smoothness'],
};

let state = { connection: { online: false }, agent: { available: false }, session: null };
let connected = false;
let sourceMode = 'upload';
let selectedFile = null;
let busy = false;
let awaitingSession = false;
let launchPreviousId = null;
let showSetup = false;
let receivedState = false;
let displayedCandidateId = null;
let followCurrent = true;
let viewMode = 'after';
let sessionIdentity = null;
let currentPreviewUrl = null;
let previewError = false;
let choiceIdentity = '';
let filmstripSignature = '';
let journalSignature = '';
let lastAnnouncement = '';
let transportError = '';
let stateRequest = null;
let pollTimer = null;
let eventStream = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

function announce(message) {
  if (!message || message === lastAnnouncement) return;
  $('live-status').textContent = message;
  lastAnnouncement = message;
}

function showError(message) {
  $('message-text').textContent = message || 'The request did not complete. Check the local bridge before trying again.';
  $('message-banner').hidden = false;
}

function safePreviewUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function visibleSession() {
  return showSetup ? null : state.session;
}

function candidates() {
  const session = visibleSession();
  return Array.isArray(session?.candidates) ? session.candidates : [];
}

function findCandidate(id) {
  return candidates().find((candidate) => candidate.id === id);
}

function currentCandidate() {
  const list = candidates();
  return findCandidate(state.session?.selectedCandidateId)
    || findCandidate(state.session?.currentCandidateId)
    || list.at(-1);
}

function shownCandidate() {
  if (viewMode === 'before') return candidates()[0];
  return (followCurrent ? currentCandidate() : findCandidate(displayedCandidateId)) || currentCandidate();
}

function canMutate() {
  return connected && !busy && !awaitingSession;
}

function setBusy(value) {
  busy = value;
  renderControls();
}

async function request(path, body = {}, extra = {}) {
  const headers = { 'X-RPA-Client': 'demo', ...extra.headers };
  let payload = body;
  if (body !== undefined && !(body instanceof File)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, { method: 'POST', headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new Error('The local bridge could not be reached. The operation may still be running; check session state before retrying.');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The bridge returned an unreadable response (${response.status}). Check the session before retrying.`);
  }
  if (!response.ok || result.error) throw new Error(result.error || `The bridge returned ${response.status}.`);
  return result;
}

function connectionLabel(node, online, label, description) {
  node.className = `connection ${connected ? (online ? 'online' : 'offline') : ''}`;
  node.lastElementChild.textContent = label;
  node.title = description || label;
}

function renderConnection() {
  connectionLabel($('lightroom-status'), state.connection?.online,
    connected ? (state.connection?.online ? 'Lightroom connected' : 'Lightroom unavailable') : 'Local bridge disconnected',
    transportError || state.connection?.message);
  const agent = state.agent || {};
  connectionLabel($('agent-status'), agent.available,
    connected ? (agent.available ? (agent.model || 'Agent ready') : 'Agent unavailable') : 'Waiting for connection',
    agent.message || [agent.provider, agent.model].filter(Boolean).join(' · '));
  document.body.classList.toggle('transport-stale', !connected);
}

function startHint() {
  if (busy) return sourceMode === 'upload' ? 'Preparing your photo with the local bridge…' : 'Starting from the selected Lightroom photo…';
  if (awaitingSession) return 'Waiting for the bridge to confirm the new session…';
  if (!connected) return transportError || 'Connecting to the local bridge…';
  if (!state.connection?.online) return state.connection?.message || 'Open Lightroom Classic and start the local bridge to begin.';
  if (!state.agent?.available) return state.agent?.message || 'The agent is unavailable. Start the signed-in Codex agent connection to begin.';
  if (state.session && !TERMINAL.has(state.session.status)) return 'Finish the current session before starting another photograph.';
  if (sourceMode === 'upload' && !selectedFile) return 'Choose a RAW file to begin. Your original will be preserved.';
  return sourceMode === 'selected' ? 'The selected RAW will be checked before a working virtual copy is created.' : 'Ready to create a working copy in Lightroom Classic.';
}

function renderControls() {
  const session = state.session;
  const status = session?.status;
  const ready = canMutate() && state.connection?.online && state.agent?.available;
  $('start-button').disabled = !(ready && (!session || TERMINAL.has(status)) && (sourceMode === 'selected' || selectedFile));
  $('start-button').firstChild.textContent = busy || awaitingSession ? 'Preparing…' : 'Begin the edit';
  $('start-hint').textContent = startHint();
  $('start-hint').classList.toggle('problem', connected && (!state.connection?.online || !state.agent?.available));
  $('raw-file').disabled = busy || awaitingSession;
  $('source-upload').disabled = busy || awaitingSession;
  $('source-selected').disabled = busy || awaitingSession;
  $('clear-file').disabled = busy || awaitingSession;
  $('intent').disabled = busy || awaitingSession;
  $('open-lightroom').disabled = !canMutate();
  $('session-controls').hidden = showSetup || !session || TERMINAL.has(status) || status === 'awaiting_choice';
  $('pause-button').hidden = status === 'paused';
  $('pause-button').disabled = !canMutate() || !['preparing', 'running'].includes(status);
  $('pause-button').lastChild.textContent = status === 'pausing' ? 'Pausing…' : 'Pause';
  $('resume-button').hidden = status !== 'paused';
  $('resume-button').disabled = !ready;
  $('stop-button').disabled = !canMutate() || status === 'pausing';
  for (const button of $('choice-options').querySelectorAll('button')) button.disabled = !canMutate();
  $('send-answer').disabled = !canMutate() || !$('custom-answer').value.trim();
  $('custom-answer').disabled = !canMutate();
}

function renderSession() {
  const session = visibleSession();
  const status = session?.status;
  const active = ACTIVE.has(status);
  $('setup-panel').hidden = Boolean(session && !showSetup);
  $('workspace-title').textContent = session && !showSetup ? (session.name || 'Edit in progress.') : 'Develop a photograph.';
  $('workspace-subtitle').textContent = session && !showSetup
    ? (session.intent || 'Review adjustments and saved versions as the session progresses.')
    : 'Choose a RAW and watch each edit take shape in Lightroom.';
  $('session-badge').textContent = STATUS_LABELS[status] || 'READY WHEN YOU ARE';
  $('session-badge').className = `session-badge ${status || ''}`;
  $('stage-strip').hidden = !session;
  $('stage-strip').classList.toggle('active', active && connected);
  $('stage-label').textContent = STATUS_LABELS[status] || 'SESSION';
  $('stage-text').textContent = session?.stage || ({
    preparing: 'Preparing the working copy', running: 'The agent is reviewing your photograph',
    pausing: 'Waiting for the current operation to finish', paused: 'The edit is paused',
    awaiting_answer: 'Your perspective will shape the next adjustment', awaiting_choice: 'Compare the real previews and choose your direction',
    completed: 'The session has finished', error: 'The session needs attention',
  }[status] || '');
  $('candidate-count').textContent = candidates().length ? `${candidates().length} saved ${candidates().length === 1 ? 'version' : 'versions'}` : '';
  $('review-choice').hidden = !['awaiting_answer', 'awaiting_choice'].includes(status);
  $('review-choice').firstChild.textContent = status === 'awaiting_answer' ? 'Add your perspective' : 'Review choices';
  document.querySelector('.journal-column').classList.toggle('active', active && connected);
  const statusText = session ? (session.error || (connected ? $('stage-text').textContent : 'Connection lost. Showing the last received session state.')) : 'Waiting for a photograph';
  $('journal-state').textContent = statusText;
  $('new-session').hidden = !session || !TERMINAL.has(status) || showSetup;
  $('new-photo').hidden = !session || !TERMINAL.has(status);
  $('new-photo').disabled = !canMutate();
  $('previous-result').hidden = !showSetup || !state.session || !TERMINAL.has(state.session.status);
  $('previous-result').textContent = state.session?.status === 'error' ? 'View previous session' : 'View previous result';
  $('previous-result').disabled = busy || awaitingSession;
  $('completion-panel').hidden = status !== 'completed';
  const selected = findCandidate(session?.selectedCandidateId);
  $('completion-title').textContent = selected ? `${selected.label || 'Your selected photograph'}, retained.` : 'Your session is complete.';
  $('completion-text').textContent = selected
    ? 'Your selected version and the edit history are retained. Open the recorded preview below or inspect the editable copy in Lightroom.'
    : 'The session and its recorded versions are retained locally. Inspect the final state in Lightroom.';
  const exportUrl = safePreviewUrl(session?.exportUrl);
  const finalUrl = exportUrl || safePreviewUrl(selected?.url);
  $('download-final').hidden = !finalUrl;
  $('download-final').firstChild.textContent = exportUrl ? 'Download JPEG' : 'Open selected preview';
  if (finalUrl) $('download-final').href = finalUrl;
  else $('download-final').removeAttribute('href');
  if (exportUrl) {
    $('download-final').setAttribute('download', 'edited-photo.jpg');
    $('download-final').removeAttribute('target');
    $('download-final').title = 'Download the recorded JPEG export, up to 8,192 pixels on the long edge.';
  } else {
    $('download-final').removeAttribute('download');
    $('download-final').setAttribute('target', '_blank');
    $('download-final').title = 'Open the selected review preview.';
  }
  if (session) announce(`${STATUS_LABELS[status] || 'Session updated'}. ${session.stage || session.error || ''}`);
}

function renderPreview() {
  const shown = shownCandidate();
  const url = safePreviewUrl(shown?.url);
  const isBefore = viewMode === 'before';
  $('view-before').disabled = !safePreviewUrl(candidates()[0]?.url);
  $('view-after').disabled = !safePreviewUrl(currentCandidate()?.url);
  $('view-before').setAttribute('aria-pressed', String(isBefore));
  $('view-after').setAttribute('aria-pressed', String(!isBefore && followCurrent));
  $('view-before').classList.toggle('active', isBefore);
  $('view-after').classList.toggle('active', !isBefore && followCurrent);
  $('preview-label').textContent = visibleSession()?.name || 'YOUR PHOTOGRAPH';
  $('preview-detail').textContent = shown?.description || 'Original RAW → native Lightroom edit → preview';
  $('preview-caption').textContent = isBefore ? 'BEFORE · ORIGINAL EDIT STATE' : (shown?.label || 'CURRENT VERSION');
  $('preview-caption').hidden = !url;
  if (url !== currentPreviewUrl) {
    currentPreviewUrl = url;
    previewError = false;
    $('image-load-note').textContent = 'Loading the recorded preview…';
    $('image-load-note').hidden = !url;
    $('main-preview').hidden = true;
    if (url) {
      $('main-preview').alt = `${isBefore ? 'Original edit state' : shown?.label || 'Edited version'}${shown?.description ? `. ${shown.description}` : ''}`;
      $('main-preview').src = url;
    } else {
      $('main-preview').removeAttribute('src');
    }
  } else if (url) {
    $('main-preview').alt = `${isBefore ? 'Original edit state' : shown?.label || 'Edited version'}${shown?.description ? `. ${shown.description}` : ''}`;
  }
  $('preview-empty').hidden = Boolean(url && !previewError);
  renderFilmstrip();
}

function renderFilmstrip() {
  const list = candidates();
  const currentId = shownCandidate()?.id;
  const signature = JSON.stringify(list.map((candidate) => [candidate.id, candidate.label, candidate.description, candidate.url]));
  $('filmstrip-section').hidden = !list.length;
  $('filmstrip-count').textContent = `${list.length} ${list.length === 1 ? 'checkpoint' : 'checkpoints'}`;
  if (signature !== filmstripSignature) {
    const fragment = document.createDocumentFragment();
    list.forEach((candidate, index) => {
      const button = element('button', 'filmstrip-card');
      button.type = 'button';
      button.dataset.candidateId = candidate.id;
      button.title = candidate.description || candidate.label || `Version ${index + 1}`;
      button.setAttribute('aria-label', `Inspect ${candidate.label || `version ${index + 1}`}`);
      const picture = element('div', 'filmstrip-picture');
      const url = safePreviewUrl(candidate.url);
      if (url) {
        const image = element('img');
        image.src = url;
        image.alt = '';
        image.loading = 'lazy';
        picture.append(image);
      }
      picture.append(element('span', 'filmstrip-number', index === 0 ? 'ORIGINAL' : String(index).padStart(2, '0')));
      button.append(picture, element('span', '', candidate.label || `Version ${index + 1}`));
      button.addEventListener('click', () => {
        followCurrent = false;
        displayedCandidateId = candidate.id;
        viewMode = index === 0 ? 'before' : 'after';
        renderPreview();
      });
      fragment.append(button);
    });
    $('filmstrip').replaceChildren(fragment);
    filmstripSignature = signature;
  }
  for (const button of $('filmstrip').children) {
    const selected = button.dataset.candidateId === currentId;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function changeLabels(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  return Object.entries(changes).flatMap(([name, value]) => {
    if (!Object.hasOwn(ADJUSTMENT_DISPLAY, name) || typeof value !== 'number' || !Number.isFinite(value)) return [];
    const [label, unit = '', signed = false] = ADJUSTMENT_DISPLAY[name];
    const amount = Object.is(value, -0) ? 0 : value;
    return [`${label}: ${signed && amount > 0 ? '+' : ''}${amount}${unit}`];
  });
}

function renderJournal() {
  const session = visibleSession();
  const events = Array.isArray(session?.events) ? session.events : [];
  $('journal-empty').hidden = Boolean(events.length);
  const signature = JSON.stringify(events);
  if (signature === journalSignature) return;
  const container = $('journal');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const previousScroll = container.scrollTop;
  const fragment = document.createDocumentFragment();
  events.forEach((event) => {
    const entry = element('li', 'journal-entry');
    if (event.type === 'error') entry.classList.add('error');
    const meta = element('div', 'entry-meta');
    const type = element('span', 'entry-type', String(event.type || 'update').replaceAll('_', ' '));
    const timestamp = element('time', 'entry-time');
    const parsed = new Date(event.at);
    if (!Number.isNaN(parsed.getTime())) {
      timestamp.dateTime = parsed.toISOString();
      timestamp.textContent = parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      timestamp.title = parsed.toLocaleString();
    }
    meta.append(type, timestamp);
    entry.append(meta, element('h3', '', event.title || 'Session update'));
    if (event.text) entry.append(element('p', '', event.text));
    const changes = changeLabels(event.changes);
    if (changes.length) {
      const chips = element('div', 'change-list');
      changes.forEach((change) => chips.append(element('span', 'change-chip', change)));
      entry.append(chips);
    }
    fragment.append(entry);
  });
  container.replaceChildren(fragment);
  journalSignature = signature;
  container.scrollTop = nearBottom ? container.scrollHeight : previousScroll;
}

function renderChoice() {
  const session = visibleSession();
  const comparison = session?.status === 'awaiting_choice' ? session.comparison : null;
  const question = session?.status === 'awaiting_answer' ? session.question : null;
  const visible = Boolean(comparison || question);
  $('choice-panel').hidden = !visible;
  if (!visible) {
    choiceIdentity = '';
    return;
  }
  const identity = JSON.stringify([session.id, comparison || question, comparison ? candidates().map((candidate) => [candidate.id, candidate.url, candidate.description]) : null]);
  if (identity === choiceIdentity) return;
  choiceIdentity = identity;
  $('choice-heading').textContent = comparison?.question || question.text;
  $('choice-help').textContent = comparison ? 'These are actual saved previews. Choose the interpretation you want to keep.' : 'Your answer guides the next decision. The agent is waiting for your perspective.';
  $('choice-options').className = `choice-options${comparison ? ' comparison-options' : ''}`;
  $('answer-form').hidden = Boolean(comparison);
  const fragment = document.createDocumentFragment();
  if (comparison) {
    (comparison.candidateIds || []).forEach((id, index) => {
      const candidate = findCandidate(id);
      if (!candidate) return;
      const letter = String.fromCharCode(65 + index);
      const button = element('button', 'comparison-card');
      button.type = 'button';
      const url = safePreviewUrl(candidate.url);
      if (url) {
        const image = element('img');
        image.src = url;
        image.alt = `${letter}: ${candidate.label || 'Edited interpretation'}`;
        button.append(image);
      }
      const copy = element('div', 'comparison-copy');
      copy.append(element('strong', '', `${letter} / ${candidate.label || 'An interpretation'}`));
      if (candidate.description) copy.append(element('p', '', candidate.description));
      const label = element('span', 'choose-label', `Choose ${letter}`);
      label.append(icon('arrow'));
      copy.append(label);
      button.append(copy);
      button.addEventListener('click', () => sessionAction('choose', { candidateId: candidate.id }));
      fragment.append(button);
    });
  } else {
    (question.options || []).forEach((answer) => {
      const button = element('button', 'choice-option', answer);
      button.type = 'button';
      button.addEventListener('click', () => sessionAction('answer', { questionId: question.id, answer }));
      fragment.append(button);
    });
  }
  $('choice-options').replaceChildren(fragment);
  $('custom-answer').value = '';
  announce(`Your input is needed. ${comparison?.question || question.text}`);
}

function applyState(next) {
  if (!next || typeof next !== 'object' || !next.connection || !next.agent) throw new Error('Invalid bridge state.');
  connected = true;
  transportError = '';
  state = next;
  const id = state.session?.id || null;
  if (awaitingSession && id && id !== launchPreviousId) awaitingSession = false;
  if (!receivedState || sessionIdentity !== id) {
    sessionIdentity = id;
    displayedCandidateId = null;
    followCurrent = true;
    viewMode = 'after';
    // A completed session is history, not the default start screen. An active
    // session always wins over a saved request to show the uploader.
    const view = new URL(location.href).searchParams.get('view');
    showSetup = !state.session || (TERMINAL.has(state.session.status)
      && (view === 'new' || (state.session.status === 'completed' && view !== 'last')));
    choiceIdentity = '';
    filmstripSignature = '';
    journalSignature = '';
  }
  receivedState = true;
  renderConnection();
  renderSession();
  renderPreview();
  renderJournal();
  renderChoice();
  renderControls();
}

async function readState() {
  if (stateRequest) return stateRequest;
  stateRequest = (async () => {
    try {
      const response = await fetch('/api/state', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Local bridge returned ${response.status}.`);
      applyState(await response.json());
    } catch (error) {
      connected = false;
      transportError = 'The local bridge is unavailable. Start the demo server, then keep this page open to reconnect.';
      renderConnection();
      renderSession();
      renderControls();
    } finally {
      stateRequest = null;
    }
  })();
  return stateRequest;
}

function startPolling() {
  if (pollTimer) return;
  readState();
  pollTimer = window.setInterval(readState, 5000);
}

function connectEvents() {
  if (!('EventSource' in window)) {
    startPolling();
    return;
  }
  eventStream = new EventSource('/api/events');
  eventStream.addEventListener('state', (event) => {
    try {
      applyState(JSON.parse(event.data));
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
    } catch {
      startPolling();
    }
  });
  eventStream.addEventListener('error', startPolling);
}

function selectSource(mode) {
  sourceMode = mode;
  $('source-upload').classList.toggle('active', mode === 'upload');
  $('source-selected').classList.toggle('active', mode === 'selected');
  $('source-upload').setAttribute('aria-pressed', String(mode === 'upload'));
  $('source-selected').setAttribute('aria-pressed', String(mode === 'selected'));
  $('drop-zone').hidden = mode !== 'upload';
  $('selected-source-note').hidden = mode !== 'selected';
  renderControls();
}

function selectFile(file) {
  if (!file) return;
  const extension = file.name.split('.').at(-1).toLowerCase();
  if (!RAW_EXTENSIONS.has(extension)) {
    $('raw-file').value = '';
    showError('Choose a camera RAW file, such as CR3, NEF, ARW, RAF, or DNG. JPEG and PNG previews cannot replace the original RAW.');
    return;
  }
  if (file.size > MAX_FILE_SIZE || !file.size) {
    $('raw-file').value = '';
    showError(file.size ? 'This RAW is larger than 200 MiB. Select it directly in Lightroom instead.' : 'This file is empty. Choose a RAW photo with image data.');
    return;
  }
  selectedFile = file;
  $('file-label').textContent = file.name;
  $('file-hint').textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MiB · RAW ready to open locally`;
  $('clear-file').hidden = false;
  announce(`${file.name} is ready. ${(file.size / (1024 * 1024)).toFixed(1)} MiB.`);
  renderControls();
}

async function beginSession() {
  if ($('start-button').disabled) return;
  $('message-banner').hidden = true;
  launchPreviousId = state.session?.id || null;
  setBusy(true);
  try {
    const intent = $('intent').value.trim() || 'Natural photographic rendering; emphasize the subject and light while preserving realistic color, atmosphere, and detail.';
    if (sourceMode === 'upload') {
      const result = await request('/api/uploads', selectedFile, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(selectedFile.name) },
      });
      if (!result.upload?.id) throw new Error('The local bridge did not return an upload ID. The editing session was not started.');
      await request('/api/sessions', { uploadId: result.upload.id, intent });
    } else {
      await request('/api/sessions', { useSelected: true, intent });
    }
    awaitingSession = true;
    showSetup = false;
    const url = new URL(location.href);
    url.searchParams.delete('view');
    history.replaceState(null, '', url);
    await readState();
  } catch (error) {
    showError(error.message);
    await readState();
  } finally {
    setBusy(false);
  }
}

async function sessionAction(action, payload) {
  const session = state.session;
  if (!session || !canMutate()) return;
  setBusy(true);
  $('message-banner').hidden = true;
  try {
    await request(`/api/sessions/${encodeURIComponent(session.id)}/${action}`, payload);
    await readState();
  } catch (error) {
    showError(error.message);
    await readState();
  } finally {
    setBusy(false);
  }
}

$('source-upload').addEventListener('click', () => selectSource('upload'));
$('source-selected').addEventListener('click', () => selectSource('selected'));
$('raw-file').addEventListener('change', (event) => selectFile(event.target.files?.[0]));
$('clear-file').addEventListener('click', () => {
  selectedFile = null;
  $('raw-file').value = '';
  $('file-label').textContent = 'Drop your RAW here';
  $('file-hint').textContent = 'or choose a file · up to 200 MiB';
  $('clear-file').hidden = true;
  renderControls();
  $('raw-file').focus();
});

for (const eventName of ['dragenter', 'dragover']) $('drop-zone').addEventListener(eventName, (event) => {
  event.preventDefault();
  if (!busy && !awaitingSession) $('drop-zone').classList.add('dragging');
});
for (const eventName of ['dragleave', 'drop']) $('drop-zone').addEventListener(eventName, (event) => {
  event.preventDefault();
  $('drop-zone').classList.remove('dragging');
});
$('drop-zone').addEventListener('drop', (event) => {
  if (busy || awaitingSession) return;
  if (event.dataTransfer?.files.length !== 1) return showError('Choose one RAW photograph for this session.');
  selectFile(event.dataTransfer.files[0]);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

$('start-button').addEventListener('click', beginSession);
$('pause-button').addEventListener('click', () => sessionAction('pause'));
$('resume-button').addEventListener('click', () => sessionAction('resume'));
$('stop-button').addEventListener('click', () => sessionAction('stop'));
$('custom-answer').addEventListener('input', renderControls);
$('send-answer').addEventListener('click', () => {
  const question = state.session?.question;
  const answer = $('custom-answer').value.trim();
  if (question && answer) sessionAction('answer', { questionId: question.id, answer });
});
$('custom-answer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('send-answer').click();
  }
});
$('view-before').addEventListener('click', () => { viewMode = 'before'; renderPreview(); });
$('review-choice').addEventListener('click', () => {
  $('choice-panel').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  $('choice-heading').focus({ preventScroll: true });
});
$('view-after').addEventListener('click', () => {
  viewMode = 'after'; followCurrent = true; displayedCandidateId = null; renderPreview();
});
$('main-preview').addEventListener('load', () => {
  if (!currentPreviewUrl || showSetup) return;
  $('main-preview').hidden = false;
  $('image-load-note').hidden = true;
  $('preview-empty').hidden = true;
});
$('main-preview').addEventListener('error', () => {
  if (!currentPreviewUrl) return;
  previewError = true;
  $('main-preview').hidden = true;
  $('preview-empty').hidden = false;
  $('image-load-note').textContent = 'This recorded preview could not be loaded. Check the local bridge or inspect the version in Lightroom.';
  $('image-load-note').hidden = false;
});
function renderWorkspace() {
  renderSession();
  renderPreview();
  renderJournal();
  renderChoice();
  renderControls();
}

function newPhoto() {
  if (!state.session || !TERMINAL.has(state.session.status) || busy || awaitingSession) return;
  showSetup = true;
  selectedFile = null;
  $('raw-file').value = '';
  $('intent').value = '';
  $('file-label').textContent = 'Drop your RAW here';
  $('file-hint').textContent = 'or choose a file · up to 200 MiB';
  $('clear-file').hidden = true;
  $('message-banner').hidden = true;
  displayedCandidateId = null;
  followCurrent = true;
  viewMode = 'after';
  selectSource('upload');
  const url = new URL(location.href);
  url.searchParams.set('view', 'new');
  history.replaceState(null, '', url);
  renderWorkspace();
  $('workspace-title').scrollIntoView({ behavior: 'instant', block: 'start' });
  $('source-upload').focus({ preventScroll: true });
  announce('Choose a new RAW photo. The previous result is saved.');
}
$('new-session').addEventListener('click', newPhoto);
$('new-photo').addEventListener('click', newPhoto);
$('previous-result').addEventListener('click', () => {
  if (!state.session || !TERMINAL.has(state.session.status) || busy || awaitingSession) return;
  showSetup = false;
  const url = new URL(location.href);
  url.searchParams.set('view', 'last');
  history.replaceState(null, '', url);
  renderWorkspace();
});
$('dismiss-message').addEventListener('click', () => { $('message-banner').hidden = true; });
$('open-lightroom').addEventListener('click', async () => {
  if (!canMutate()) return;
  setBusy(true);
  try {
    await request('/api/lightroom/open');
    announce('Lightroom is opening in its own window.');
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) readState(); });
window.addEventListener('online', readState);
window.addEventListener('pagehide', () => {
  eventStream?.close();
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { readState(); connectEvents(); }
});

const narrowLayout = window.matchMedia('(max-width: 850px)');
const journalColumn = document.querySelector('.journal-column');
function positionJournal() {
  if (narrowLayout.matches) document.querySelector('.photo-column').insertBefore(journalColumn, $('filmstrip-section'));
  else document.querySelector('.workbench').append(journalColumn);
}
narrowLayout.addEventListener('change', positionJournal);
positionJournal();
readState();
connectEvents();

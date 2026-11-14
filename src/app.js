
import { createMultiplayerClient } from './network.js';
import { initAsteroidsBackground, startAsteroids, stopAsteroids, setAsteroidsMode, setAsteroidPlayerColors } from './asteroidsBackground.js';
import { settings, DEFAULT_HOTKEYS, validateHotkeyAssignment } from './settings.js';
import { normalizeAudioBuffer, calculatePeak, linearToDb } from './audioNormalizer.js';
import {
  saveLastWorkedLobby,
  getLastWorkedLobby,
  saveCompletedDub,
  getAllSavedDubs,
  deleteSavedDub,
  clearAllSavedDubs,
  formatDateString,
  formatDurationMinSec,
  formatFileSize,
  extractCollaborators
} from './savedDubsStore.js';
import {
  getAuthMode,
  isGuestUser,
  getAuthDisplayName,
  enterGuestMode,
  submitPreparedLogin
} from './auth.js';

const appId = 'loop-booth-mp';
const multiplayer = createMultiplayerClient();
let auth = null;
let db = multiplayer.db;
let firebaseModules = null;

if (typeof document !== 'undefined') {
  initAsteroidsBackground('bgAsteroids');
  if (settings.get('asteroidsMode')) {
    setAsteroidsMode(settings.get('asteroidsMode'));
  }
}

async function loadFirebase(){
  if(firebaseModules) return firebaseModules;
  firebaseModules = multiplayer.api;
  return firebaseModules;
}

const PLAYER_COLORS = [
  '#B285F5',
  '#10B981',
  '#E8A33D',
  '#3B82F6',
  '#EC4899',
  '#06B6D4',
  '#F97316',
  '#A3E635'
];

const state = {
  uid: null,
  me: null,       // { id, name, color }
  roomId: null,
  isHost: false,
  isSingleplayer: false,
  scoringMode: false,
  gameMode: 'coop', // 'coop' | 'party'
  roomData: null, // latest snapshot of room doc
  
  // Audio/Video state
  file: null,
  videoURL: null,
  duration: 0,
  envelope: null,
  masterBuffer: null,
  backgroundBuffer: null, // vocal-reduced version of masterBuffer, for the continuous background bed
  
  // Studio state
  fragments: [],  // synced from roomData.fragments
  takes: {},      // local dict mapping fragId -> { uid: { audioBuffer, score, trace, base64 } }
  currentIndex: 0,
  masterMultiTrack: false,
  editMode: false,
  undoStack: [],
  
  // Playback
  micStream: null,
  audioCtx: null,
  isPlaying: false,
  paused: false,
  rafId: null,
  pb: null,
  liveTrace: [],
  unsubRoom: null,
  unsubTakes: null,
  roomEventUnsub: null,
  videoSyncing: false,
  videoSyncedName: null,
  syncProgress: 0,
  playerActivities: {} // uid -> { activity, fragId, fragIndex, playerName, updatedAt }
};

const el = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getAnonymousPlayerName(slotIndex = 0) {
  const num = Math.min(8, Math.max(1, (slotIndex || 0) + 1));
  return `anon${num}`;
}

function isPartyMode() {
  if (state.isSingleplayer) return false;
  const mode = state.roomData?.gameMode || state.gameMode;
  return mode === 'party';
}

function isPartyHost() {
  return isPartyMode() && Boolean(state.isHost);
}

function getPartyState() {
  return state.roomData?.party || null;
}

function formatTimeSecTenths(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
}

function formatTimecode(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
}

function updateMasterFragmentsDuration() {
  const valEl = el('masterFragmentsTotalDurationVal');
  if (!valEl) return;
  const frags = Array.isArray(state.fragments) ? state.fragments : [];
  const totalSec = frags.reduce((sum, f) => {
    const start = Number(f?.start);
    const end = Number(f?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return sum;
    return sum + Math.max(0, end - start);
  }, 0);
  valEl.textContent = formatTimecode(totalSec);
}

/**
 * Creates a smooth progress stepper that advances strictly 1 percentage point at a time
 * without jumping, even when network or compute progress completes quickly or in large bursts.
 */
function createProgressStepper({
  fillEl = null,
  textEl = null,
  textSuffix = '%',
  textPrefix = '',
  initial = 0,
  minStepMs = 6,
  maxStepMs = 15,
  onStep = null,
  onComplete = null
} = {}) {
  let current = Math.max(0, Math.min(100, Math.round(initial)));
  let target = current;
  let active = true;
  let timer = null;
  let completionResolvers = [];

  function render(val) {
    if (fillEl) {
      fillEl.style.width = `${val}%`;
    }
    if (textEl) {
      textEl.textContent = `${textPrefix}${val}${textSuffix}`;
    }
    if (typeof onStep === 'function') {
      try { onStep(val); } catch (_) {}
    }
  }

  render(current);

  function notifyComplete() {
    if (typeof onComplete === 'function') {
      try { onComplete(); } catch (_) {}
    }
    const resolvers = completionResolvers.slice(0);
    completionResolvers = [];
    resolvers.forEach(r => {
      try { r(); } catch (_) {}
    });
  }

  function tick() {
    if (!active) return;
    if (current < target) {
      current += 1;
      render(current);

      if (current >= 100 && target >= 100) {
        timer = null;
        notifyComplete();
        return;
      }
    } else if (current >= target && target >= 100) {
      timer = null;
      notifyComplete();
      return;
    }

    if (current < target) {
      const gap = target - current;
      // When gap is large, step at minimum interval; otherwise smooth cruising speed
      const delay = gap > 40 ? minStepMs : (gap > 15 ? Math.round((minStepMs + maxStepMs) / 2) : maxStepMs);
      timer = setTimeout(tick, delay);
    } else {
      timer = null;
    }
  }

  return {
    get current() {
      return current;
    },
    get target() {
      return target;
    },
    setTarget(newTarget) {
      if (!active) return;
      const clamped = Math.max(0, Math.min(100, Math.round(newTarget)));
      if (clamped > target) {
        target = clamped;
        if (!timer && current < target) {
          tick();
        }
      }
    },
    async finish(targetPct = 100) {
      if (!active) return;
      target = Math.max(target, Math.min(100, Math.round(targetPct)));
      if (current >= target) {
        render(target);
        return;
      }
      return new Promise((resolve) => {
        completionResolvers.push(resolve);
        if (!timer) tick();
      });
    },
    setImmediate(val) {
      current = Math.max(0, Math.min(100, Math.round(val)));
      target = current;
      if (timer) { clearTimeout(timer); timer = null; }
      render(current);
    },
    stop() {
      active = false;
      if (timer) { clearTimeout(timer); timer = null; }
      notifyComplete();
    }
  };
}

function showNotice(msg, type = 'error', durationMs = 4200){
  const container = el('toastContainer');
  if(!container){
    if(el('noticeText') && el('notice')){
      el('noticeText').textContent = msg;
      el('notice').classList.add('show');
      setTimeout(() => el('notice')?.classList.remove('show'), durationMs);
    }
    return;
  }

  // Deduplication: if exact same message is currently visible, refresh its pulse & timer
  const existing = Array.from(container.children).find(t => t.querySelector('.toast-text')?.textContent === msg);
  if (existing) {
    existing.classList.remove('fading-out');
    existing.style.animation = 'none';
    existing.offsetHeight; /* trigger reflow */
    existing.style.animation = 'toastSlideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
    if (existing._dismissTimer) {
      clearTimeout(existing._dismissTimer);
      existing._dismissTimer = null;
    }
    if (durationMs > 0 && typeof existing._dismissFn === 'function') {
      existing._dismissTimer = setTimeout(existing._dismissFn, durationMs);
    }
    return;
  }

  // Cap number of simultaneous toasts to avoid clutter
  while (container.children.length >= 4) {
    const oldest = container.firstChild;
    if (oldest?._dismissTimer) clearTimeout(oldest._dismissTimer);
    container.removeChild(oldest);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  
  let iconHtml = '';
  if(type === 'error'){
    iconHtml = `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" /></svg>`;
  } else if(type === 'warning'){
    iconHtml = `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>`;
  } else if(type === 'success'){
    iconHtml = `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`;
  } else {
    iconHtml = `<svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.247.25v3.25H9a.75.75 0 000 1.5h2a.75.75 0 000-1.5h-.25V10.5A1.5 1.5 0 009.25 9H9z" clip-rule="evenodd" /></svg>`;
  }

  const textSpan = document.createElement('span');
  textSpan.className = 'toast-text';
  textSpan.textContent = msg;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&times;';

  toast.innerHTML = iconHtml;
  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);

  let isDismissed = false;
  const dismiss = () => {
    if(isDismissed) return;
    isDismissed = true;
    if (toast._dismissTimer) {
      clearTimeout(toast._dismissTimer);
      toast._dismissTimer = null;
    }
    toast.classList.add('fading-out');
    setTimeout(() => {
      if(toast.parentNode) toast.parentNode.removeChild(toast);
    }, 420);
  };
  toast._dismissFn = dismiss;

  closeBtn.onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };
  toast.onclick = dismiss;

  container.appendChild(toast);

  if(durationMs > 0){
    toast._dismissTimer = setTimeout(dismiss, durationMs);
  }
}

let confirmCallback = null;
function showConfirm(title, desc, callback) {
  if (!el('confirmModal')) return;
  el('confirmTitle').textContent = title;
  el('confirmDesc').textContent = desc;
  confirmCallback = callback;
  el('confirmModal').classList.add('active');
}

const HOTKEY_ACTION_LABELS = {
  playPause: 'Play / Review Takes',
  record: 'Record Take',
  listen: 'Listen Original',
  pause: 'Pause / Resume',
  prevLine: 'Previous Line',
  nextLine: 'Next Line',
  undo: 'Undo Split / Merge',
  editSplits: 'Toggle Split Mode',
};

let activeSettingsTab = 'basics';
let capturingHotkeyAction = null;
let conflictHighlightAction = null;
let conflictHighlightTimer = null;

  function getHotkeys() {
    return { ...DEFAULT_HOTKEYS, ...(settings.get('hotkeys') || {}) };
  }

  function formatKeyCode(code) {
    if (!code || typeof code !== 'string') return '?';
    if (code === 'Space') return 'Space';
    if (code.startsWith('Key') && code.length === 4) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
    const map = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      BracketLeft: '[',
      BracketRight: ']',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      Comma: ',',
      Period: '.',
      Slash: '/',
      Semicolon: ';',
      Quote: "'",
      Backslash: '\\',
      Enter: 'Enter',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Del',
    };
    if (map[code]) return map[code];
    return code.replace(/^Numpad/, 'Num ');
  }

  function getHotkeyLabel(action) {
    const hotkeys = getHotkeys();
    return formatKeyCode(hotkeys[action] || DEFAULT_HOTKEYS[action]);
  }

  function isCodeBoundToAnyHotkey(hotkeys, code) {
    return Object.values(hotkeys).includes(code);
  }

  function syncHotkeyHintsUI() {
    const hotkeys = getHotkeys();

    if (typeof document !== 'undefined') {
      document.querySelectorAll('[data-hotkey-chip]').forEach((chip) => {
        const action = chip.getAttribute('data-hotkey-chip');
        if (action && hotkeys[action]) {
          chip.textContent = formatKeyCode(hotkeys[action]);
        }
      });

      document.querySelectorAll('.hotkey-bind-btn[data-hotkey-action]').forEach((btn) => {
        const action = btn.getAttribute('data-hotkey-action');
        if (!action) return;
        const isCapturing = capturingHotkeyAction === action;
        const isConflict = conflictHighlightAction === action;
        const code = hotkeys[action] || DEFAULT_HOTKEYS[action];
        const isCustom = code !== DEFAULT_HOTKEYS[action];
        btn.classList.toggle('is-capturing', isCapturing);
        btn.classList.toggle('is-conflict', isConflict);
        btn.classList.toggle('is-custom', isCustom && !isCapturing && !isConflict);
        btn.textContent = isCapturing ? 'Press key...' : formatKeyCode(code);
      });
    }

    const hintEl = el('hotkeyCaptureHint');
    if (hintEl) {
      if (capturingHotkeyAction) {
        const actionName = HOTKEY_ACTION_LABELS[capturingHotkeyAction] || capturingHotkeyAction;
        hintEl.innerHTML = `Listening for <strong style="color:#79F2B8;">${escapeHtml(actionName)}</strong> — press any single key (or <kbd class="kbd-chip" style="padding:1px 5px; font-size:10px;">Esc</kbd> to cancel).`;
      } else {
        hintEl.innerHTML = `Click any key binding and press a new key to customize. Press <kbd class="kbd-chip" style="padding:1px 5px; font-size:10px;">Esc</kbd> to cancel.`;
      }
    }

    // Keep studio button hints & tooltips synchronized
    const listenHint = el('listenBtn')?.querySelector('.key-hint');
    if (listenHint) listenHint.textContent = getHotkeyLabel('listen');

    const reviewHint = el('reviewBtn')?.querySelector('.key-hint');
    if (reviewHint) reviewHint.textContent = getHotkeyLabel('playPause');

    const recordHint = el('recordBtn')?.querySelector('.key-hint');
    if (recordHint) recordHint.textContent = getHotkeyLabel('record');

    const pauseHint = el('pauseBtn')?.querySelector('.key-hint');
    if (pauseHint) pauseHint.textContent = getHotkeyLabel('pause');

    const undoBtn = el('undoBtn');
    if (undoBtn) {
      const undoLabel = getHotkeyLabel('undo');
      const undoHint = undoBtn.querySelector('.key-hint');
      if (undoHint) undoHint.textContent = undoLabel;
      undoBtn.title = `Undo last split or merge (${undoLabel})`;
    }

    if (el('prevFragBtn')) {
      el('prevFragBtn').title = `Previous Line (${getHotkeyLabel('prevLine')})`;
    }
    if (el('nextFragBtn')) {
      el('nextFragBtn').title = `Next Line (${getHotkeyLabel('nextLine')})`;
    }
    if (el('editToggle')) {
      el('editToggle').title = `Host only: click master timeline to split (${getHotkeyLabel('editSplits')})`;
    }
  }

  function flashHotkeyConflict(conflictAction) {
    if (conflictHighlightTimer) {
      clearTimeout(conflictHighlightTimer);
      conflictHighlightTimer = null;
    }
    conflictHighlightAction = conflictAction || null;
    syncHotkeyHintsUI();
    if (conflictHighlightAction) {
      conflictHighlightTimer = setTimeout(() => {
        conflictHighlightAction = null;
        conflictHighlightTimer = null;
        syncHotkeyHintsUI();
      }, 1400);
    }
  }

  function applyValidatedHotkeyAssignment(targetAction, keyEvent) {
    const hotkeys = getHotkeys();
    const validation = validateHotkeyAssignment(targetAction, keyEvent.code, hotkeys, {
      key: keyEvent.key,
      ctrlKey: keyEvent.ctrlKey,
      metaKey: keyEvent.metaKey,
      altKey: keyEvent.altKey,
    });

    if (!validation.valid) {
      if (validation.reason === 'modifier-only') return false;

      if (validation.reason === 'conflict') {
        const keyLabel = formatKeyCode(keyEvent.code);
        const conflictLabel = HOTKEY_ACTION_LABELS[validation.conflictAction] || validation.conflictAction;
        const targetLabel = HOTKEY_ACTION_LABELS[targetAction] || targetAction;
        flashHotkeyConflict(validation.conflictAction);
        showNotice(
          `Conflict detected: "${keyLabel}" is already bound to "${conflictLabel}". Choose a different key for "${targetLabel}".`,
          "warning",
          3400
        );
        return false;
      }

      showNotice(validation.message || "Invalid hotkey selection.", "warning", 2500);
      return false;
    }

    conflictHighlightAction = null;
    if (conflictHighlightTimer) {
      clearTimeout(conflictHighlightTimer);
      conflictHighlightTimer = null;
    }

    const nextHotkeys = { ...hotkeys, [targetAction]: validation.code };
    capturingHotkeyAction = null;
    settings.set('hotkeys', nextHotkeys);
    syncHotkeyHintsUI();

    const actionLabel = HOTKEY_ACTION_LABELS[targetAction] || targetAction;
    const keyLabel = formatKeyCode(validation.code);
    showNotice(
      validation.unchanged
        ? `${actionLabel} remains bound to ${keyLabel}.`
        : `Bound ${actionLabel} to ${keyLabel}.`,
      validation.unchanged ? "info" : "success",
      2400
    );
    return true;
  }

  // Settings Modal Controller & Helpers
  function switchSettingsTab(tabName = 'basics') {
    const validTabs = ['basics', 'audio', 'hotkeys', 'visuals', 'session', 'credits'];
    activeSettingsTab = validTabs.includes(tabName) ? tabName : 'basics';

    if (activeSettingsTab !== 'hotkeys' && capturingHotkeyAction) {
      capturingHotkeyAction = null;
      conflictHighlightAction = null;
      syncHotkeyHintsUI();
    }

    if (typeof document !== 'undefined') {
      document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
        const isActive = btn.getAttribute('data-settings-tab') === activeSettingsTab;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
        const isActive = panel.getAttribute('data-settings-panel') === activeSettingsTab;
        panel.classList.toggle('is-active', isActive);
      });

      const bodyEl = document.querySelector('#settingsModal .settings-body');
      if (bodyEl) bodyEl.scrollTop = 0;
    }
  }

  function openSettingsModal(initialTab = 'basics') {
    capturingHotkeyAction = null;
    conflictHighlightAction = null;
    switchSettingsTab(initialTab);
    syncSettingsUI();
    if (el('settingsModal')) {
      el('settingsModal').classList.add('active');
    }
  }

  function closeSettingsModal() {
    capturingHotkeyAction = null;
    conflictHighlightAction = null;
    if (conflictHighlightTimer) {
      clearTimeout(conflictHighlightTimer);
      conflictHighlightTimer = null;
    }
    syncHotkeyHintsUI();
    if (el('settingsModal')) {
      el('settingsModal').classList.remove('active');
    }
  }

  function updateNormBadge() {
    const badge = el('studioNormBadge');
    if (!badge) return;
    const isAutoNorm = Boolean(settings.get('autoNormalize'));
    const targetDb = settings.get('targetPeakDb');
    if (isAutoNorm) {
      badge.textContent = `Norm: ${targetDb} dBFS`;
      badge.style.display = 'inline-flex';
    } else {
      badge.textContent = 'Norm: Off';
      badge.style.display = 'inline-flex';
      badge.style.opacity = '0.6';
    }
  }

  function isSimpleModeActive() {
    const pref = settings.get('simpleMode');
    if (pref === true || pref === false) return pref;
    const studioActive = el('studioScreen')?.classList.contains('active');
    if (studioActive || state.roomId) {
      return !state.isSingleplayer && !state.isHost;
    }
    return false;
  }

  function applySimpleMode() {
    const active = isSimpleModeActive();
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('simple-mode', active);
    }
    if (el('settingSimpleMode')) {
      el('settingSimpleMode').checked = active;
    }
    if (el('simpleModeBadge')) {
      const pref = settings.get('simpleMode');
      const isAuto = pref !== true && pref !== false;
      el('simpleModeBadge').textContent = isAuto
        ? (active ? 'Auto (Guest)' : 'Auto (Full)')
        : (active ? 'On (Simple)' : 'Off (Full)');
      el('simpleModeBadge').classList.toggle('active', active);
    }
    if (typeof updateActiveLineTranscriptUI === 'function') {
      updateActiveLineTranscriptUI();
    }
    if (el('studioScreen')?.classList.contains('active') && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (typeof renderMasterCanvas === 'function') renderMasterCanvas();
        if (state.fragments[state.currentIndex] && typeof drawWave === 'function') {
          drawWave(state.fragments[state.currentIndex]);
        }
      });
    }
  }

  function syncSettingsUI() {
    const autoNorm = Boolean(settings.get('autoNormalize'));
    if (el('settingAutoNorm')) el('settingAutoNorm').checked = autoNorm;
    if (el('normStatusBadge')) {
      el('normStatusBadge').textContent = autoNorm ? 'Active' : 'Off';
      el('normStatusBadge').classList.toggle('active', autoNorm);
    }

    if (el('settingTargetPeak')) {
      el('settingTargetPeak').value = String(settings.get('targetPeakDb'));
    }
    if (el('settingSilenceFloor')) {
      el('settingSilenceFloor').value = String(settings.get('silenceThresholdDb'));
    }

    const shortcutsEnabled = Boolean(settings.get('keyboardShortcuts'));
    if (el('settingShortcutsToggle')) el('settingShortcutsToggle').checked = shortcutsEnabled;
    if (el('shortcutsBadge')) {
      el('shortcutsBadge').textContent = shortcutsEnabled ? 'Enabled' : 'Disabled';
      el('shortcutsBadge').classList.toggle('active', shortcutsEnabled);
    }

    const keyHints = Boolean(settings.get('showKeyHints'));
    if (el('settingKeyHintsToggle')) el('settingKeyHintsToggle').checked = keyHints;
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('hide-key-hints', !keyHints);
    }
    syncHotkeyHintsUI();

    const latency = settings.get('micLatencyMs') ?? 0;
    if (el('settingLatencyRange')) el('settingLatencyRange').value = String(latency);
    if (el('settingLatencyVal')) el('settingLatencyVal').textContent = `${latency > 0 ? '+' : ''}${latency} ms`;

    if (el('settingAutoAdvance')) el('settingAutoAdvance').checked = Boolean(settings.get('autoAdvance'));
    if (el('settingShowSubtitles')) el('settingShowSubtitles').checked = Boolean(settings.get('showSubtitles'));
    const astMode = settings.get('asteroidsMode') || 'glow';
    if (el('settingAsteroidsMode')) el('settingAsteroidsMode').value = astMode;
    updateMonitorSubtitle();
    applySimpleMode();

    if (el('diagRoomCode')) {
      el('diagRoomCode').textContent = state.roomId || (state.isSingleplayer ? 'SOLO-OFFLINE' : 'LOCAL');
    }
    if (el('diagRole')) {
      el('diagRole').textContent = state.isSingleplayer ? 'Solo Dubber' : (state.isHost ? 'Host' : 'Guest Dubber');
    }
    if (el('diagNetwork')) {
      el('diagNetwork').textContent = state.isSingleplayer ? 'Local (Offline)' : 'WebSocket Mesh (Live)';
    }
    if (el('diagTakesCount')) {
      let totalTakes = 0;
      for (const fragId in state.takes) {
        totalTakes += Object.keys(state.takes[fragId] || {}).length;
      }
      el('diagTakesCount').textContent = `${totalTakes} recorded`;
    }
    if (el('diagAccountMode')) {
      el('diagAccountMode').textContent = isGuestUser() ? 'Guest (Temporary)' : getAuthDisplayName();
    }

    updateNormBadge();
  }

  function reNormalizeAllTakes(showToast = true) {
    const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
    const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;
    const ctx = ensureCtx();
    let count = 0;

    for (const fragId in state.takes) {
      const fragTakes = state.takes[fragId];
      if (!fragTakes) continue;
      for (const uid in fragTakes) {
        const takeObj = fragTakes[uid];
        if (takeObj && takeObj.buffer) {
          const norm = normalizeAudioBuffer(ctx, takeObj.buffer, targetDb, { silenceThresholdDb: silenceFloor });
          takeObj.buffer = norm.buffer;
          takeObj.normalized = true;
          takeObj.normalizedDb = norm.normalizedPeakDb;
          count++;
        }
      }
    }

    renderFragmentList();
    renderMasterCanvas();
    if (state.fragments[state.currentIndex]) {
      drawWave(state.fragments[state.currentIndex]);
      updateLaneScoreDisplay(state.fragments[state.currentIndex]);
    }

    if (showToast) {
      if (count > 0) {
        showNotice(`Normalized ${count} take${count > 1 ? 's' : ''} to ${targetDb} dBFS.`, "success", 3000);
      } else {
        showNotice(`Target output level set to ${targetDb} dBFS. Takes will auto-normalize as you record!`, "info", 3000);
      }
    }
  }

if (typeof document !== 'undefined') {
  const cancelBtn = el('confirmCancelBtn');
  if (cancelBtn) cancelBtn.onclick = () => {
    if (el('confirmModal')) el('confirmModal').classList.remove('active');
    confirmCallback = null;
  };

  const okBtn = el('confirmOkBtn');
  if (okBtn) okBtn.onclick = () => {
    if (el('confirmModal')) el('confirmModal').classList.remove('active');
    if (confirmCallback) confirmCallback();
  };

  const modalEl = el('confirmModal');
  if (modalEl) modalEl.onclick = (e) => {
    if (e.target === modalEl) {
      modalEl.classList.remove('active');
      confirmCallback = null;
    }
  };

  // Bind settings modal controls
  if (el('settingsBtnSetup')) el('settingsBtnSetup').onclick = () => openSettingsModal('basics');
  if (el('settingsBtnMp')) el('settingsBtnMp').onclick = () => openSettingsModal('basics');
  if (el('settingsBtnLobby')) el('settingsBtnLobby').onclick = () => openSettingsModal('basics');
  if (el('settingsBtnStudio')) el('settingsBtnStudio').onclick = () => openSettingsModal('basics');
  if (el('settingsCloseBtn')) el('settingsCloseBtn').onclick = closeSettingsModal;
  if (el('settingsDoneBtn')) el('settingsDoneBtn').onclick = closeSettingsModal;

  const settingsModalEl = el('settingsModal');
  if (settingsModalEl) {
    settingsModalEl.onclick = (e) => {
      if (e.target === settingsModalEl) closeSettingsModal();
    };
  }

  if (el('settingAutoNorm')) {
    el('settingAutoNorm').onchange = () => {
      const enabled = Boolean(el('settingAutoNorm').checked);
      settings.set('autoNormalize', enabled);
      syncSettingsUI();
      if (enabled) {
        reNormalizeAllTakes(false);
        showNotice("Auto-normalization active. Recorded takes will have consistent volume.", "info", 2600);
      } else {
        showNotice("Auto-normalization disabled.", "info", 2000);
      }
    };
  }

  if (el('settingTargetPeak')) {
    el('settingTargetPeak').onchange = () => {
      const val = parseFloat(el('settingTargetPeak').value);
      settings.set('targetPeakDb', val);
      syncSettingsUI();
      if (settings.get('autoNormalize')) {
        reNormalizeAllTakes(false);
        showNotice(`Target output level updated to ${val} dBFS.`, "info", 2200);
      }
    };
  }

  if (el('settingSilenceFloor')) {
    el('settingSilenceFloor').onchange = () => {
      const val = parseFloat(el('settingSilenceFloor').value);
      settings.set('silenceThresholdDb', val);
      syncSettingsUI();
    };
  }

  if (el('settingRenormalizeBtn')) {
    el('settingRenormalizeBtn').onclick = () => reNormalizeAllTakes(true);
  }

  if (el('settingShortcutsToggle')) {
    el('settingShortcutsToggle').onchange = () => {
      const enabled = Boolean(el('settingShortcutsToggle').checked);
      settings.set('keyboardShortcuts', enabled);
      syncSettingsUI();
      showNotice(
        enabled
          ? `Keyboard shortcuts enabled (${getHotkeyLabel('playPause')}, ${getHotkeyLabel('record')}, ${getHotkeyLabel('listen')}, ${getHotkeyLabel('pause')}, ${getHotkeyLabel('prevLine')}/${getHotkeyLabel('nextLine')}).`
          : "Keyboard shortcuts disabled.",
        "info",
        2400
      );
    };
  }

  if (el('settingKeyHintsToggle')) {
    el('settingKeyHintsToggle').onchange = () => {
      const enabled = Boolean(el('settingKeyHintsToggle').checked);
      settings.set('showKeyHints', enabled);
      syncSettingsUI();
    };
  }

  if (typeof document !== 'undefined') {
    document.querySelectorAll('.hotkey-bind-btn[data-hotkey-action]').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-hotkey-action');
        if (!action) return;
        conflictHighlightAction = null;
        capturingHotkeyAction = capturingHotkeyAction === action ? null : action;
        syncHotkeyHintsUI();
      };
    });
  }

  if (el('resetHotkeysBtn')) {
    el('resetHotkeysBtn').onclick = () => {
      capturingHotkeyAction = null;
      conflictHighlightAction = null;
      settings.set('hotkeys', { ...DEFAULT_HOTKEYS });
      syncSettingsUI();
      showNotice("Keyboard hotkeys reset to defaults.", "info", 2200);
    };
  }

  if (el('settingLatencyRange')) {
    el('settingLatencyRange').oninput = () => {
      const val = parseInt(el('settingLatencyRange').value, 10);
      settings.set('micLatencyMs', val);
      if (el('settingLatencyVal')) el('settingLatencyVal').textContent = `${val > 0 ? '+' : ''}${val} ms`;
    };
  }

  if (el('settingAutoAdvance')) {
    el('settingAutoAdvance').onchange = () => {
      settings.set('autoAdvance', Boolean(el('settingAutoAdvance').checked));
    };
  }

  if (el('settingSimpleMode')) {
    el('settingSimpleMode').onchange = () => {
      const enabled = Boolean(el('settingSimpleMode').checked);
      settings.set('simpleMode', enabled);
      applySimpleMode();
      showNotice(
        enabled
          ? "Simple Recording Mode enabled — uncluttered view for easy recording."
          : "Full Studio Mode enabled — all editing and export tools shown.",
        "info",
        2500
      );
    };
  }

  if (el('settingShowSubtitles')) {
    el('settingShowSubtitles').onchange = () => {
      const enabled = Boolean(el('settingShowSubtitles').checked);
      settings.set('showSubtitles', enabled);
      updateMonitorSubtitle();
      showNotice(
        enabled ? "Playing fragment subtitles enabled." : "Playing fragment subtitles hidden.",
        "info",
        2200
      );
    };
  }

  if (el('settingAsteroidsMode')) {
    el('settingAsteroidsMode').onchange = () => {
      const mode = el('settingAsteroidsMode').value;
      settings.set('asteroidsMode', mode);
      setAsteroidsMode(mode);
    };
  }

  if (el('settingsResetBtn')) {
    el('settingsResetBtn').onclick = () => {
      settings.reset();
      setAsteroidsMode('glow');
      syncSettingsUI();
      updateMonitorSubtitle();
      showNotice("Settings reset to defaults.", "info", 2400);
    };
  }

  document.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
    tabBtn.onclick = () => {
      const targetTab = tabBtn.getAttribute('data-settings-tab') || 'basics';
      switchSettingsTab(targetTab);
    };
  });

  document.querySelectorAll('[data-jump-settings-tab]').forEach((jumpBtn) => {
    jumpBtn.onclick = () => {
      const targetTab = jumpBtn.getAttribute('data-jump-settings-tab') || 'basics';
      switchSettingsTab(targetTab);
    };
  });

  // Initialize UI state from saved settings
  syncSettingsUI();

  // Check if user opened an invite link (?room=CODE or ?r=CODE)
  function checkUrlInvite() {
    if (typeof window === 'undefined' || !window.location) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const code = (params.get('room') || params.get('r') || '').trim().toUpperCase();
      if (code && /^[A-Z0-9]{3,8}$/.test(code)) {
        if (el('roomCodeInput')) el('roomCodeInput').value = code;
        switchScreen('multiplayerScreen');
        showNotice(`Invited to room ${code}! Enter your name and click Join.`, "info", 5000);
        setTimeout(() => {
          el('playerNameInput')?.focus();
        }, 250);
      }
    } catch (err) {
      console.warn("URL invite check error:", err);
    }
  }
  checkUrlInvite();

  // Global Keyboard Shortcuts
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      // 0. If currently capturing a custom hotkey inside Advanced Settings
      if (capturingHotkeyAction) {
        if (e.key === 'Escape' || e.code === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          capturingHotkeyAction = null;
          conflictHighlightAction = null;
          syncHotkeyHintsUI();
          return;
        }

        const validationProbe = validateHotkeyAssignment(capturingHotkeyAction, e.code, getHotkeys(), {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
        });
        if (validationProbe.reason === 'modifier-only') return;

        e.preventDefault();
        e.stopPropagation();
        applyValidatedHotkeyAssignment(capturingHotkeyAction, e);
        return;
      }

      // 1. If currently typing inside any input or editable field, never intercept typing
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const isInput = activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable;
      if (isInput) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
        }
        return;
      }

      // 2. Escape closes modals, popovers, or stops playback
      if (e.key === 'Escape') {
        if (typeof closeEmotePopovers === 'function') {
          const hadOpenEmote = Boolean(
            (el('studioEmotePopover') && el('studioEmotePopover').style.display !== 'none') ||
            (el('lobbyEmotePopover') && el('lobbyEmotePopover').style.display !== 'none')
          );
          closeEmotePopovers();
          if (hadOpenEmote) return;
        }
        if (el('authModal')?.classList.contains('active')) {
          if (typeof closeAuthModal === 'function') closeAuthModal();
          return;
        }
        if (el('compareTakesModal')?.classList.contains('active')) {
          closeCompareTakesModal();
          return;
        }
        if (el('settingsModal')?.classList.contains('active')) {
          closeSettingsModal();
          return;
        }
        if (el('confirmModal')?.classList.contains('active')) {
          el('confirmModal').classList.remove('active');
          confirmCallback = null;
          return;
        }
        if (typeof stopPartyAudition === 'function' && partyAuditionPlay) {
          stopPartyAudition();
          return;
        }
        if (state.isPlaying) {
          stopPlayback();
          return;
        }
      }

      // 3. Toggle Settings Modal ('s', 'S', or '?')
      if (e.key === 's' || e.key === 'S' || e.key === '?') {
        if (el('authModal')?.classList.contains('active')) return;
        e.preventDefault();
        if (el('settingsModal')?.classList.contains('active')) {
          closeSettingsModal();
        } else {
          openSettingsModal();
        }
        return;
      }

      // 4. Check if keyboard shortcuts are enabled by user in settings (and no modal is open)
      if (!settings.get('keyboardShortcuts')) return;
      if (el('settingsModal')?.classList.contains('active') || el('confirmModal')?.classList.contains('active') || el('compareTakesModal')?.classList.contains('active') || el('authModal')?.classList.contains('active') || el('partyWinnerModal')?.classList.contains('active')) return;

      const studioActive = el('studioScreen')?.classList.contains('active');
      const hotkeys = getHotkeys();
      const partyLockedToPhase = isPartyMode() && getPartyState()?.phase !== 'recording';

      // Play / Review Takes (default: Space)
      if (e.code === hotkeys.playPause) {
        e.preventDefault();
        if (studioActive && !partyLockedToPhase) {
          if (state.isPlaying) {
            if (state.pb?.mode === 'record') {
              finishPlayback();
            } else {
              if (el('pauseBtn') && !el('pauseBtn').disabled) el('pauseBtn').click();
            }
          } else if (state.paused) {
            if (el('pauseBtn') && !el('pauseBtn').disabled) el('pauseBtn').click();
          } else {
            const f = state.fragments[state.currentIndex];
            const takes = f ? (state.takes[f.id] || {}) : {};
            if (Object.keys(takes).length > 0 && el('reviewBtn') && !el('reviewBtn').disabled) {
              el('reviewBtn').click();
            } else if (el('listenBtn') && !el('listenBtn').disabled) {
              el('listenBtn').click();
            }
          }
        }
        return;
      }

      // Record Take (default: R)
      if (e.code === hotkeys.record) {
        if (studioActive && !partyLockedToPhase) {
          e.preventDefault();
          if (state.isPlaying && state.pb?.mode === 'record') {
            finishPlayback();
          } else if (el('recordBtn') && !el('recordBtn').disabled) {
            el('recordBtn').click();
          }
        }
        return;
      }

      // Listen Original (default: L)
      if (e.code === hotkeys.listen) {
        if (studioActive && !partyLockedToPhase && el('listenBtn') && !el('listenBtn').disabled) {
          e.preventDefault();
          el('listenBtn').click();
        }
        return;
      }

      // Pause / Resume (default: P)
      if (e.code === hotkeys.pause) {
        if (studioActive && !partyLockedToPhase && el('pauseBtn') && !el('pauseBtn').disabled) {
          e.preventDefault();
          el('pauseBtn').click();
        }
        return;
      }

      // Previous Line (default: ArrowLeft / fallback '[')
      if (
        e.code === hotkeys.prevLine ||
        (hotkeys.prevLine === 'ArrowLeft' && e.code === 'BracketLeft' && !isCodeBoundToAnyHotkey(hotkeys, 'BracketLeft'))
      ) {
        if (studioActive && (!isPartyMode() || (state.isHost && state.editMode)) && el('prevFragBtn') && !el('prevFragBtn').disabled) {
          e.preventDefault();
          el('prevFragBtn').click();
        }
        return;
      }

      // Next Line (default: ArrowRight / fallback ']')
      if (
        e.code === hotkeys.nextLine ||
        (hotkeys.nextLine === 'ArrowRight' && e.code === 'BracketRight' && !isCodeBoundToAnyHotkey(hotkeys, 'BracketRight'))
      ) {
        if (studioActive && (!isPartyMode() || (state.isHost && state.editMode)) && el('nextFragBtn') && !el('nextFragBtn').disabled) {
          e.preventDefault();
          el('nextFragBtn').click();
        }
        return;
      }

      // Undo (Host, default: U)
      if (e.code === hotkeys.undo) {
        if (studioActive && state.isHost && (!isPartyMode() || state.editMode) && el('undoBtn') && !el('undoBtn').disabled) {
          e.preventDefault();
          el('undoBtn').click();
        }
        return;
      }

      // Toggle Edit Splits (Host, default: E)
      if (e.code === hotkeys.editSplits) {
        if (studioActive && state.isHost) {
          const editInput = el('editToggleInput');
          if (editInput) {
            e.preventDefault();
            editInput.checked = !editInput.checked;
            editInput.dispatchEvent(new Event('change'));
          }
        }
        return;
      }

      // 1-9 Number keys to jump directly to line
      if (/^Digit[1-9]$/.test(e.code)) {
        if (studioActive && (!isPartyMode() || (state.isHost && state.editMode))) {
          const idx = parseInt(e.key, 10) - 1;
          if (idx >= 0 && idx < state.fragments.length) {
            e.preventDefault();
            selectFragment(idx);
          }
        }
        return;
      }
    });
  }

  const openSavedDubsOrRecent = () => {
    renderSavedDubsScreen();
    switchScreen('savedDubsScreen');
  };

  const savedDubsBtn = el('savedDubsBtn');
  if (savedDubsBtn) {
    savedDubsBtn.onclick = openSavedDubsOrRecent;
  }

  const recentSessionsBtn = el('recentSessionsBtn');
  if (recentSessionsBtn) {
    recentSessionsBtn.onclick = openSavedDubsOrRecent;
  }

  const savedDubsBackBtn = el('savedDubsBackBtn');
  if (savedDubsBackBtn) savedDubsBackBtn.onclick = () => switchScreen('setupScreen');

  const clearSavedDubsBtn = el('clearSavedDubsBtn');
  if (clearSavedDubsBtn) {
    clearSavedDubsBtn.onclick = () => {
      if (isGuestUser()) {
        showNotice("Saved Dubs & Recent Sessions are not available in Guest mode.", "info", 2600);
        return;
      }
      showConfirm("Clear Saved History?", "Are you sure you want to clear your saved dubs history and last active lobby?", () => {
        clearAllSavedDubs();
        renderSavedDubsScreen();
        showNotice("Saved history cleared.", "info", 2000);
      });
    };
  }

  const scoringToggle = el('scoringToggle');
  if (scoringToggle) {
    scoringToggle.onchange = async () => {
      state.scoringMode = Boolean(scoringToggle.checked);
      if (el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);
      if (el('studioScoreModeBadge')) el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';

      showNotice(
        state.scoringMode
          ? "Wave Match Scoring enabled! Takes will be scored based on voice dynamics & rhythm."
          : "Wave Match Scoring disabled.",
        "info",
        2400
      );

      persistCurrentSession();

      if (!isSoloSession() && state.isHost && state.roomId) {
        sendPlaybackEvent({ action: 'toggle-scoring', scoringMode: state.scoringMode });
        try {
          const fb = await loadFirebase();
          if (fb) {
            const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
            await fb.updateDoc(roomRef, { scoringMode: state.scoringMode });
          }
        } catch (err) {
          console.warn("Failed to sync scoring mode to room:", err);
        }
      }
    };
  }
}

function persistCurrentSession() {
  if (isGuestUser()) return;
  if (!state.roomId && !state.isSingleplayer) return;
  try {
    saveLastWorkedLobby({
      roomId: state.roomId,
      isSingleplayer: Boolean(state.isSingleplayer),
      isHost: Boolean(state.isHost),
      videoName: state.file?.name || state.videoSyncedName || 'Custom Video Clip',
      videoSize: state.file?.size || null,
      duration: state.duration || 0,
      players: state.players || (state.me ? [state.me] : []),
      scoringMode: Boolean(state.scoringMode),
      audioNormalized: Boolean(settings.get('autoNormalize')),
      fragments: state.fragments,
      takes: state.takes,
      uid: state.uid,
      createdAt: state.sessionCreatedAt || Date.now()
    });
  } catch (e) {
    console.warn("Session auto-persist error:", e);
  }
}

function renderSavedDubsScreen() {
  const container = el('savedDubsList');
  if (!container) return;

  const clearBtn = el('clearSavedDubsBtn');
  if (isGuestUser()) {
    if (clearBtn) clearBtn.style.display = 'none';
    container.innerHTML = `
      <div class="guest-locked-card" role="status">
        <div class="guest-locked-icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        </div>
        <div class="guest-locked-title">Not Part of the Guest Version</div>
        <p class="guest-locked-desc">
          Saved Dubs &amp; Recent Sessions are disabled while playing as a Guest. Your recordings stay temporary for this session only — you can still download your finished dub directly from the studio, and sign in once accounts open to unlock saved history.
        </p>
        <div class="guest-locked-actions">
          <button type="button" class="btn btn-primary" id="guestSavedSignInBtn">Account &amp; Sign In</button>
          <button type="button" class="btn" id="guestSavedBackMenuBtn">Back to Menu</button>
        </div>
      </div>
    `;
    if (el('guestSavedSignInBtn')) {
      el('guestSavedSignInBtn').onclick = () => {
        if (typeof openAuthModal === 'function') openAuthModal();
      };
    }
    if (el('guestSavedBackMenuBtn')) {
      el('guestSavedBackMenuBtn').onclick = () => switchScreen('setupScreen');
    }
    return;
  }

  if (clearBtn) clearBtn.style.display = '';
  const dubs = getAllSavedDubs();

  if (!dubs || dubs.length === 0) {
    container.innerHTML = `
      <div class="dub-empty-card">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent); opacity:0.85;">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
        <div style="font-size: 15.5px; font-weight: 600; color: var(--text);">No Saved Dubs or Recent Lobbies Yet</div>
        <p style="font-size: 12.5px; color: var(--text-dim); max-width: 400px; margin: 0 auto; line-height: 1.45;">
          Start a Solo practice or join a Multiplayer room. As you split lines, record takes, and export finished dubs, your work will be automatically saved here!
        </p>
        <button class="btn btn-primary" id="emptyStartSoloBtn" style="margin-top: 6px;">
          Start Solo Session
        </button>
      </div>
    `;
    const btn = el('emptyStartSoloBtn');
    if (btn) btn.onclick = () => {
      switchScreen('setupScreen');
      if (el('singleplayerBtn')) el('singleplayerBtn').click();
    };
    return;
  }

  container.innerHTML = dubs.map((dub, index) => {
    const isTopLobby = Boolean(dub.isLastLobby || index === 0);
    const dateFormatted = formatDateString(dub.updatedAt || dub.createdAt);
    const durationFormatted = formatDurationMinSec(dub.duration);
    const coverage = dub.coveragePercent || 0;
    const linesTotal = dub.linesCount || 0;
    const completedLines = dub.completedLines || (linesTotal > 0 && coverage ? Math.round((coverage / 100) * linesTotal) : 0);
    const takesTotal = dub.takesCount || 0;
    const isSolo = Boolean(dub.isSingleplayer);
    const roomBadgeText = isSolo ? 'SOLO WORKSPACE' : `ROOM: ${dub.roomId || 'LOCAL'}`;
    const scoreBadgeHtml = dub.scoringMode && dub.avgScore
      ? `<span class="dub-stat-value" style="color:#FBBF24;">★ ${dub.avgScore}% Match</span>`
      : `<span class="dub-stat-value" style="color:var(--text-dim);">Standard</span>`;
    const normText = dub.audioNormalized ? 'Normalized (-1.0 dBFS)' : 'Standard Gain';

    const collabs = Array.isArray(dub.collaborators) && dub.collaborators.length
      ? dub.collaborators
      : [{ name: isSolo ? 'Solo Dubber' : 'Room Host', color: '#B285F5', role: isSolo ? 'Solo Artist' : 'Host', takesCount: takesTotal }];

    const collabsHtml = collabs.map(c => `
      <span class="dub-collaborator-pill" title="${c.role}${c.takesCount ? ` • ${c.takesCount} takes` : ''}">
        <span class="dub-collaborator-dot" style="background:${c.color || '#B285F5'};"></span>
        <strong style="font-weight:600;">${escapeHtml(c.name || 'Dubber')}</strong>
        <span style="color:var(--text-dim); font-size:10.5px;">(${c.role}${c.takesCount ? ` • ${c.takesCount} takes` : ''})</span>
      </span>
    `).join('');

    const pinnedBadgeHtml = isTopLobby
      ? `<div class="dub-card-pinned-tag">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
          <span>LAST WORKED LOBBY (SAVED CONTENT)</span>
        </div>`
      : '';

    return `
      <div class="dub-card ${isTopLobby ? 'is-last-lobby' : ''}" data-id="${dub.id}">
        ${pinnedBadgeHtml}
        <div class="dub-card-header">
          <div class="dub-card-title-group">
            <div class="dub-card-title">
              <span>${escapeHtml(dub.title || dub.videoName || 'Dub Session')}</span>
              <span class="dub-room-badge">${roomBadgeText}</span>
            </div>
            <div class="dub-card-date">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <span>Saved ${dateFormatted}</span>
              ${dub.videoSize ? `<span style="opacity:0.6;">• ${dub.videoSize}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="dub-card-details-grid">
          <div class="dub-stat-block">
            <span class="dub-stat-label">Duration</span>
            <span class="dub-stat-value">${durationFormatted}</span>
          </div>
          <div class="dub-stat-block">
            <span class="dub-stat-label">Lines / Coverage</span>
            <span class="dub-stat-value">${completedLines}/${linesTotal} lines (${coverage}%)</span>
          </div>
          <div class="dub-stat-block">
            <span class="dub-stat-label">Takes Recorded</span>
            <span class="dub-stat-value">${takesTotal} takes</span>
          </div>
          <div class="dub-stat-block">
            <span class="dub-stat-label">Match Scoring</span>
            ${scoreBadgeHtml}
          </div>
          <div class="dub-stat-block">
            <span class="dub-stat-label">Audio Level</span>
            <span class="dub-stat-value" style="font-size:11.5px; color:${dub.audioNormalized ? 'var(--green)' : 'var(--text-dim)'};">${normText}</span>
          </div>
        </div>

        <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-dim); margin-bottom:6px; font-family:var(--font-mono);">
          Collaborators & Dubbers:
        </div>
        <div class="dub-collaborators-row">
          ${collabsHtml}
        </div>

        <div class="dub-card-actions">
          <button class="btn btn-ghost btn-delete-dub" data-id="${dub.id}" style="font-size:12.5px; padding:6px 10px; color:var(--text-dim);" title="Delete this saved session">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            <span>Delete</span>
          </button>
          ${dub.exportUrl ? `
            <a class="btn btn-ghost" href="${dub.exportUrl}" download="${escapeHtml(dub.videoName || 'dub')}.webm" style="font-size:12.5px; padding:6px 12px; text-decoration:none;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              <span>Download Export</span>
            </a>
          ` : ''}
          <button class="btn btn-primary btn-resume-dub" data-id="${dub.id}" style="font-size:13px; padding:7px 16px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            <span>${isTopLobby ? 'Re-enter Studio / Lobby' : 'Resume Session'}</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Wire up resume and delete buttons
  container.querySelectorAll('.btn-resume-dub').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-id');
      const targetDub = dubs.find(d => d.id === id);
      if (targetDub) {
        resumeSavedSession(targetDub);
      }
    };
  });

  container.querySelectorAll('.btn-delete-dub').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-id');
      showConfirm("Delete Saved Dub?", "Are you sure you want to remove this saved session from history?", () => {
        deleteSavedDub(id);
        renderSavedDubsScreen();
        showNotice("Saved session removed.", "info", 2000);
      });
    };
  });
}

function resumeSavedSession(targetDub) {
  if (!targetDub) return;

  // Restore room and session mode
  state.roomId = targetDub.roomId || 'SOLO';
  state.isSingleplayer = Boolean(targetDub.isSingleplayer);
  state.isHost = true;
  state.scoringMode = Boolean(targetDub.scoringMode);
  state.duration = targetDub.duration || 0;
  state.videoSyncedName = targetDub.videoName || null;

  // Restore fragments
  if (Array.isArray(targetDub.fragments) && targetDub.fragments.length > 0) {
    state.fragments = JSON.parse(JSON.stringify(targetDub.fragments));
  } else {
    state.fragments = [];
  }

  // Restore takes metadata
  if (targetDub.takes && typeof targetDub.takes === 'object') {
    state.takes = { ...targetDub.takes };
  } else {
    state.takes = {};
  }

  // Restore players list with anon1..anon4 fallbacks for multiplayer, never anon for singleplayer
  const primaryName = targetDub.collaborators?.[0]?.name;
  if (state.isSingleplayer) {
    state.uid = 'local_player';
    const soloName = (primaryName && !primaryName.startsWith('anon')) ? primaryName : 'Solo Dubber';
    state.me = { id: state.uid, name: soloName, color: PLAYER_COLORS[0], ready: true };
    state.players = [state.me];
  } else {
    state.uid = state.uid || 'anon1_host';
    state.me = { id: state.uid, name: primaryName || 'anon1', color: PLAYER_COLORS[0], ready: true };
    state.players = (Array.isArray(targetDub.collaborators) && targetDub.collaborators.length)
      ? targetDub.collaborators.map((c, i) => ({
          id: c.id || `anon${i+1}`,
          name: c.name || getAnonymousPlayerName(i),
          color: c.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
          ready: true
        }))
      : [state.me];
  }

  // CRITICAL: Always initialize roomData so startStudio and handlers never encounter null
  state.roomData = {
    id: state.roomId,
    hostId: state.uid,
    players: state.players,
    status: 'lobby',
    videoName: targetDub.videoName || null,
    videoSize: targetDub.videoSizeBytes || null,
    scoringMode: state.scoringMode,
    fragments: state.fragments
  };

  if(el('scoringToggle')) {
    el('scoringToggle').disabled = false;
    el('scoringToggle').checked = state.scoringMode;
  }
  if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

  // Check if we have the video loaded or if file needs selection
  const v = el('mainVideo');
  if (state.file || (v && v.src && v.src !== window.location.href)) {
    state.roomData.status = 'studio';
    enterStudio();
    showNotice(`Resumed session for "${targetDub.title}" with ${state.fragments.length} lines.`, "success", 3000);
  } else {
    // Show lobby with dropzone prompting for video to reopen studio
    if (el('startStudioBtn')) el('startStudioBtn').disabled = true;

    if (state.isSingleplayer) {
      updateLobbyCodeUI('SOLO');
      if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'block';
      if (el('lobbyGuestUI')) el('lobbyGuestUI').style.display = 'none';
      renderLobbyPlayers(state.players, state.uid);
      if (el('hostDropzone')) {
        el('hostDropzone').innerHTML = `
          <strong style="color:var(--accent);">Restored: ${escapeHtml(targetDub.title)}</strong><br>
          <span style="font-size:12px; color:var(--text-dim);">${state.fragments.length} lines & ${targetDub.takesCount || 0} takes restored. Click or drop video file to launch studio.</span>
        `;
      }
      switchScreen('lobbyScreen');
      showNotice(`Session restored! Select "${targetDub.videoName || 'your video'}" to launch studio.`, "info", 4000);
    } else {
      updateLobbyCodeUI(state.roomId);
      if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'block';
      if (el('lobbyGuestUI')) el('lobbyGuestUI').style.display = 'none';
      renderLobbyPlayers(state.players, state.uid);
      if (el('hostDropzone')) {
        el('hostDropzone').innerHTML = `
          <strong style="color:var(--accent);">Restored Room ${state.roomId}</strong><br>
          <span style="font-size:12px; color:var(--text-dim);">${state.fragments.length} lines restored. Select video to reopen.</span>
        `;
      }
      switchScreen('lobbyScreen');
      showNotice(`Lobby ${state.roomId} restored with ${state.fragments.length} lines!`, "info", 4000);
    }
  }

  persistCurrentSession();
}

function isSoloSession() {
  return Boolean(state.isSingleplayer || !state.roomId || state.roomId === 'LOCAL');
}

function updateLobbyCodeUI(code) {
  if (el('lobbyRoomCode')) el('lobbyRoomCode').textContent = code;
  const copyBtn = el('copyInviteBtn');
  if (copyBtn) {
    if (code === 'SOLO' || isSoloSession()) {
      copyBtn.style.display = 'none';
    } else {
      copyBtn.style.display = 'inline-flex';
    }
  }
}

function resetToMenu() {
  persistCurrentSession();
  if (state.unsubRoom) { state.unsubRoom(); state.unsubRoom = null; }
  if (state.unsubTakes) { state.unsubTakes(); state.unsubTakes = null; }
  if (state.roomEventUnsub) { state.roomEventUnsub(); state.roomEventUnsub = null; }
  
  if (typeof stopPartyAudition === 'function') stopPartyAudition();
  if (typeof stopPartyFinalePlayback === 'function') stopPartyFinalePlayback();
  stopPlayback();
  
  if (state.videoURL) { URL.revokeObjectURL(state.videoURL); state.videoURL = null; }
  const video = el('mainVideo');
  if (video) {
    video.removeAttribute('src');
    video.load();
  }

  state.roomId = null;
  state.isHost = false;
  state.isSingleplayer = false;
  state.scoringMode = false;
  state.gameMode = 'coop';
  state.roomData = null;
  state.file = null;
  state.duration = 0;
  state.envelope = null;
  state.masterBuffer = null;
  state.backgroundBuffer = null;
  state.videoSyncing = false;
  state.videoSyncedName = null;
  state.fragments = [];
  state.takes = {};
  state.currentIndex = 0;
  state.masterMultiTrack = false;
  state.editMode = false;
  state.undoStack = [];
  state.playerActivities = {};
  lastMasterTrackHeaderSig = '';
  autoTranscribedFragKeys.clear();
  autoTranscribeKeyMissing = false;
  if (typeof resetPartyTrackingState === 'function') resetPartyTrackingState();

  if (el('undoBtn')) el('undoBtn').disabled = true;
  if (el('masterCanvas')) el('masterCanvas').style.height = '';
  if (el('masterTrackHeaders')) {
    el('masterTrackHeaders').style.display = 'none';
    el('masterTrackHeaders').innerHTML = '';
  }
  const resetMasterPanel = el('masterCanvas')?.closest('.master-panel');
  if (resetMasterPanel) resetMasterPanel.classList.remove('is-multitrack');
  if (el('masterMultiTrackBtn')) {
    el('masterMultiTrackBtn').classList.remove('is-active');
    el('masterMultiTrackBtn').setAttribute('aria-pressed', 'false');
  }
  if (el('masterMultiTrackBtnText')) el('masterMultiTrackBtnText').textContent = 'Multi-Track';
  updateMasterFragmentsDuration();
  updateMonitorSubtitle();
  if (el('setupLoader')) el('setupLoader').style.display = 'none';
  if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'none';
  if (el('lobbyGuestUI')) el('lobbyGuestUI').style.display = 'none';
  if (el('startStudioBtn')) el('startStudioBtn').disabled = true;
  if (el('hostFileInput')) el('hostFileInput').value = '';
  if (el('hostDropzone')) el('hostDropzone').textContent = 'Click or drop a video file here';
  if (el('scoringToggle')) {
    el('scoringToggle').checked = false;
    el('scoringToggle').disabled = false;
  }
  if (el('scoringHostNote')) el('scoringHostNote').style.display = 'none';
  if (el('scoreModeBadge')) el('scoreModeBadge').classList.remove('active');
  if (el('studioScoreModeBadge')) el('studioScoreModeBadge').style.display = 'none';
  if (el('laneScoreBadge')) {
    el('laneScoreBadge').style.display = 'none';
    el('laneScoreBadge').className = 'lane-score-badge';
  }
  
  const copyBtn = el('copyInviteBtn');
  if (copyBtn) {
    copyBtn.style.display = 'none';
    copyBtn.classList.remove('copied');
  }
  const copyText = el('copyInviteText');
  if (copyText) copyText.textContent = 'Copy Invite Link';

  if (el('hostUploadUI')) el('hostUploadUI').style.display = 'none';
  if (el('guestMatchUI')) el('guestMatchUI').style.display = 'none';
  if (el('syncProgressFill')) el('syncProgressFill').style.width = '0%';
  if (el('syncProgressText')) el('syncProgressText').textContent = '0%';
  if (el('hostUploadProgressFill')) el('hostUploadProgressFill').style.width = '0%';
  if (el('hostUploadProgressText')) el('hostUploadProgressText').textContent = '0%';
  if (el('monitorLoadingBarFill')) el('monitorLoadingBarFill').style.width = '0%';
  if (el('monitorLoadingPercent')) el('monitorLoadingPercent').textContent = '0%';
  if (el('renderProgressFill')) el('renderProgressFill').style.width = '0%';
  if (el('renderProgress')) el('renderProgress').classList.remove('show');
  if (el('renderStatus')) el('renderStatus').textContent = '';
  if (el('downloadLink')) {
    el('downloadLink').classList.remove('show');
    el('downloadLink').removeAttribute('href');
  }
  if (el('downloadVocalsLink')) {
    el('downloadVocalsLink').classList.remove('show');
    el('downloadVocalsLink').removeAttribute('href');
  }
  if (lastFinalDownloadUrl) { URL.revokeObjectURL(lastFinalDownloadUrl); lastFinalDownloadUrl = null; }
  if (lastVocalsDownloadUrl) { URL.revokeObjectURL(lastVocalsDownloadUrl); lastVocalsDownloadUrl = null; }
  if (el('renderBtn')) {
    el('renderBtn').disabled = false;
    el('renderBtn').classList.remove('is-success');
  }
  if (el('downloadOptionsBtn')) {
    el('downloadOptionsBtn').disabled = false;
    el('downloadOptionsBtn').classList.remove('is-success');
  }
  if (typeof closeDownloadOptionsMenu === 'function') closeDownloadOptionsMenu();
  if (typeof syncDownloadOptionsUI === 'function') syncDownloadOptionsUI();
  if (typeof closeCompareTakesModal === 'function') closeCompareTakesModal();
  if (typeof closeEmotePopovers === 'function') closeEmotePopovers();
  if (typeof syncEmoteMenuVisibility === 'function') syncEmoteMenuVisibility();
  if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
  if (el('partyFlowBanner')) el('partyFlowBanner').style.display = 'none';
  if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'none';
  if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'none';
  if (el('lanePanel')) el('lanePanel').style.display = '';
  if (el('studioTransport')) el('studioTransport').style.display = '';
  if (el('partyRedoMenu')) el('partyRedoMenu').style.display = 'none';

  setAsteroidPlayerColors([]);
  if (typeof document !== 'undefined') {
    document.body.classList.remove('simple-mode', 'party-mode', 'party-host', 'party-guest', 'party-finale-phase', 'host-edit-mode');
    document.querySelectorAll('[data-mp-mode]').forEach((btn) => {
      const sel = btn.getAttribute('data-mp-mode') === 'coop';
      btn.classList.toggle('is-selected', sel);
      btn.setAttribute('aria-checked', sel ? 'true' : 'false');
    });
  }
  switchScreen('setupScreen');
}

function openMultiplayerScreenWithMode(mode = 'coop') {
  const chosen = mode === 'party' ? 'party' : 'coop';
  state.gameMode = chosen;
  if (typeof document !== 'undefined') {
    document.querySelectorAll('[data-mp-mode]').forEach((btn) => {
      const isSel = btn.getAttribute('data-mp-mode') === chosen;
      btn.classList.toggle('is-selected', isSel);
      btn.setAttribute('aria-checked', isSel ? 'true' : 'false');
    });
  }
  switchScreen('multiplayerScreen');
  setTimeout(() => {
    el('playerNameInput')?.focus();
  }, 120);
}

if (typeof document !== 'undefined') {
  const lobbyBackBtn = el('lobbyBackBtn');
  if (lobbyBackBtn) {
    lobbyBackBtn.onclick = () => {
      if (isSoloSession()) {
        resetToMenu();
        return;
      }
      showConfirm('Leave Lobby?', 'Are you sure you want to return to the main menu? You will disconnect from this room.', resetToMenu);
    };
  }

  const mpBackBtn = el('mpBackBtn');
  if (mpBackBtn) {
    mpBackBtn.onclick = () => {
      switchScreen('setupScreen');
    };
  }

  const playCoopStudioBtn = el('playCoopStudioBtn');
  if (playCoopStudioBtn) {
    playCoopStudioBtn.onclick = () => openMultiplayerScreenWithMode('coop');
  }

  const playPartyShowdownBtn = el('playPartyShowdownBtn');
  if (playPartyShowdownBtn) {
    playPartyShowdownBtn.onclick = () => openMultiplayerScreenWithMode('party');
  }

  const playMultiplayerBtn = el('playMultiplayerBtn');
  if (playMultiplayerBtn) {
    playMultiplayerBtn.onclick = () => openMultiplayerScreenWithMode('coop');
  }

  const studioBackBtn = el('studioBackBtn');
  if (studioBackBtn) {
    studioBackBtn.onclick = () => {
      if (isSoloSession()) {
        resetToMenu();
        return;
      }
      showConfirm('Leave Studio?', 'Are you sure you want to return to the main menu? You will disconnect from this session.', resetToMenu);
    };
  }

  const copyInviteBtn = el('copyInviteBtn');
  if (copyInviteBtn) {
    copyInviteBtn.onclick = async () => {
      if (isSoloSession() || !state.roomId || state.roomId === 'LOCAL') {
        return showNotice("Solo sessions cannot be shared. Host a multiplayer room to invite friends.", "info");
      }
      const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(state.roomId)}`;
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(inviteUrl);
          copied = true;
        } else {
          const ta = document.createElement('textarea');
          ta.value = inviteUrl;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          copied = document.execCommand('copy');
          document.body.removeChild(ta);
        }
      } catch (err) {
        console.warn("Clipboard copy fallback:", err);
      }

      if (copied) {
        const textSpan = el('copyInviteText');
        const originalText = textSpan ? textSpan.textContent : 'Copy Invite Link';
        if (textSpan) textSpan.textContent = 'Link Copied!';
        copyInviteBtn.classList.add('copied');
        showNotice(`Invite link for room ${state.roomId} copied to clipboard!`, "success", 3000);
        setTimeout(() => {
          if (textSpan) textSpan.textContent = originalText;
          copyInviteBtn?.classList.remove('copied');
        }, 2200);
      } else {
        window.prompt("Copy this invite link to share with friends:", inviteUrl);
      }
    };
  }
}

function switchScreen(id){
  if (typeof closeEmotePopovers === 'function') closeEmotePopovers();
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (el(id)) el(id).classList.add('active');
  }

  if (typeof syncEmoteMenuVisibility === 'function') {
    syncEmoteMenuVisibility();
  }

  if (id === 'setupScreen' || id === 'multiplayerScreen' || id === 'savedDubsScreen') {
    setAsteroidPlayerColors([]);
  } else {
    syncAsteroidPlayerColors();
  }

  // Asteroids remain visible in menu, lobby, and record screen if enabled in settings
  if (settings.get('asteroidsMode') !== 'off') {
    startAsteroids();
  } else {
    stopAsteroids();
  }
}

function ensureCtx(){
  if(!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}

async function authenticate(){
  if(state.uid) return true;
  if (el('setupLoader')) el('setupLoader').style.display = 'block';
  const fb = await loadFirebase();
  if(!fb){ if (el('setupLoader')) el('setupLoader').style.display = 'none'; return false; }
  try {
    let cred;
    if (typeof __initial_auth_token !== 'undefined') {
      cred = await fb.signInWithCustomToken(auth, __initial_auth_token);
    } else {
      cred = await fb.signInAnonymously(auth);
    }
    state.uid = cred.user.uid;
    return true;
  } catch(e) {
    console.error("Auth error:", e);
    showNotice("Authentication failed.");
    if (el('setupLoader')) el('setupLoader').style.display = 'none';
    return false;
  }
}

function syncAsteroidPlayerColors() {
  if (state.isSingleplayer || !state.roomId || state.roomId === 'LOCAL') {
    setAsteroidPlayerColors([]);
    return;
  }
  const players = (Array.isArray(state.roomData?.players) && state.roomData.players.length > 0)
    ? state.roomData.players
    : (Array.isArray(state.players) ? state.players : []);
  const purpleHex = PLAYER_COLORS[0].toLowerCase();
  const joinedColors = [];
  for (const p of players) {
    const hex = (p?.color || '').trim();
    if (hex && hex.toLowerCase() !== purpleHex && !joinedColors.some((c) => c.toLowerCase() === hex.toLowerCase())) {
      joinedColors.push(hex);
    }
  }
  setAsteroidPlayerColors(joinedColors);
}

function renderLobbyPlayers(players, hostId){
  syncAsteroidPlayerColors();
  const container = el('lobbyPlayerList');
  if(!container) return;
  const isSolo = isSoloSession();
  container.innerHTML = (players || []).map((player, idx) => {
    const progress = Number.isFinite(player?.syncProgress) ? player.syncProgress : 0;
    const isSyncing = !player?.ready && progress > 0;
    const status = player?.ready
      ? 'Ready'
      : isSyncing
        ? `<span>Syncing ${progress}%</span><span class="player-sync-bar"><span style="width:${progress}%"></span></span>`
        : 'Waiting';
    let pName = player?.name;
    if (!pName || (isSolo && pName.startsWith('anon'))) {
      pName = isSolo ? 'Solo Dubber' : getAnonymousPlayerName(idx);
    }
    const hostTag = (!isSolo && player?.id === hostId) ? '(Host)' : '';
    return `
      <div class="player-row">
        <div class="player-swatch" style="background:${player?.color || '#B285F5'}"></div>
        <div class="player-name">${pName} ${hostTag}</div>
        <div class="player-status ${player?.ready ? 'ready' : ''}">${status}</div>
      </div>
    `;
  }).join('');
}

function syncLobbyGameModeUI(data = state.roomData) {
  const isSolo = isSoloSession();
  const mode = !isSolo && (data?.gameMode === 'party' || state.gameMode === 'party') ? 'party' : 'coop';
  if (!isSolo && data?.gameMode) {
    state.gameMode = mode;
  }
  const maxPlayers = mode === 'party' ? 8 : 4;
  const players = Array.isArray(data?.players) ? data.players : (Array.isArray(state.players) ? state.players : []);

  if (el('lobbyGameModeRow')) {
    el('lobbyGameModeRow').style.display = isSolo ? 'none' : 'flex';
  }
  if (el('lobbyPartyToggle')) {
    el('lobbyPartyToggle').checked = mode === 'party';
    el('lobbyPartyToggle').disabled = !state.isHost || isSolo;
  }
  if (el('partyModeBadge')) {
    el('partyModeBadge').classList.toggle('active', mode === 'party');
  }
  if (el('gameModeHostNote')) {
    el('gameModeHostNote').style.display = (!isSolo && !state.isHost) ? 'block' : 'none';
  }
  if (el('lobbyPlayersCount')) {
    el('lobbyPlayersCount').textContent = isSolo ? '1 / 1 Solo' : `${players.length} / ${maxPlayers} Players`;
  }
  if (el('lobbyPartyHint')) {
    el('lobbyPartyHint').style.display = mode === 'party' ? 'inline-flex' : 'none';
  }
  if (el('startStudioBtn')) {
    el('startStudioBtn').textContent = mode === 'party' ? 'Start Party Showdown' : 'Start Studio';
  }
}

if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-mp-mode]').forEach((btn) => {
    btn.onclick = () => {
      const chosen = btn.getAttribute('data-mp-mode') === 'party' ? 'party' : 'coop';
      state.gameMode = chosen;
      document.querySelectorAll('[data-mp-mode]').forEach((b) => {
        const isSel = b.getAttribute('data-mp-mode') === chosen;
        b.classList.toggle('is-selected', isSel);
        b.setAttribute('aria-checked', isSel ? 'true' : 'false');
      });
    };
  });

  if (el('lobbyPartyToggle')) {
    el('lobbyPartyToggle').onchange = async () => {
      if (!state.isHost || isSoloSession()) return;
      const isParty = Boolean(el('lobbyPartyToggle').checked);
      state.gameMode = isParty ? 'party' : 'coop';
      if (state.roomData) state.roomData.gameMode = state.gameMode;
      syncLobbyGameModeUI(state.roomData);
      showNotice(
        isParty
          ? 'Party Showdown enabled (4–8 players): dub 1 line at a time, vote & watch together!'
          : 'Switched back to Co-op Studio mode (1–4 players).',
        'info',
        2600
      );
      try {
        const fb = await loadFirebase();
        if (fb && state.roomId) {
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          await fb.updateDoc(roomRef, { gameMode: state.gameMode });
        }
      } catch (err) {
        console.warn('Failed to sync gamemode to room:', err);
      }
    };
  }
}

if (el('singleplayerBtn')) {
  el('singleplayerBtn').onclick = () => {
    const inputVal = el('playerNameInput')?.value.trim();
    const name = inputVal || 'Solo Dubber';
    state.isSingleplayer = true;
    state.uid = 'local_player';
    state.isHost = true;
    state.roomId = 'LOCAL';
    state.gameMode = 'coop';
    state.me = { id: state.uid, name, color: PLAYER_COLORS[0], ready: true };
    state.players = [state.me];
    state.roomData = {
      id: 'LOCAL',
      hostId: state.uid,
      players: [state.me],
      status: 'lobby',
      videoName: null,
      videoSize: null,
      scoringMode: state.scoringMode,
      gameMode: 'coop',
      fragments: []
    };
    
    updateLobbyCodeUI('SOLO');
    syncLobbyGameModeUI(state.roomData);
    renderLobbyPlayers(state.players, state.uid);
    if(el('scoringToggle')) {
      el('scoringToggle').disabled = false;
      el('scoringToggle').checked = state.scoringMode;
    }
    if(el('scoringHostNote')) el('scoringHostNote').style.display = 'none';
    if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

    if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'block';
    if (el('startStudioBtn')) el('startStudioBtn').disabled = true; // wait for file
    switchScreen('lobbyScreen');
  };
}

if (el('createRoomBtn')) {
  el('createRoomBtn').onclick = async () => {
    const inputVal = el('playerNameInput')?.value.trim();
    const name = inputVal || 'anon1';
    try {
      const ok = await authenticate();
      if(!ok) return showNotice("Could not connect to authentication service.", "error");
      const fb = await loadFirebase();
      if(!fb) return showNotice("Could not initialize connection.", "error");
      
      const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
      const selectedModeBtn = document.querySelector('[data-mp-mode].is-selected');
      const gameMode = selectedModeBtn?.getAttribute('data-mp-mode') === 'party' ? 'party' : (state.gameMode === 'party' ? 'party' : 'coop');
      state.roomId = roomId;
      state.isHost = true;
      state.isSingleplayer = false;
      state.gameMode = gameMode;
      state.scoringMode = Boolean(el('scoringToggle')?.checked);
      state.me = { id: state.uid, name, color: PLAYER_COLORS[0], ready: false };
      state.players = [state.me];
      state.roomData = {
        id: roomId,
        hostId: state.uid,
        players: [state.me],
        status: 'lobby',
        videoName: null,
        videoSize: null,
        scoringMode: state.scoringMode,
        gameMode,
        fragments: []
      };
      
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', roomId);
      await fb.setDoc(roomRef, state.roomData);
      
      if(el('scoringToggle')) el('scoringToggle').disabled = false;
      if(el('scoringHostNote')) el('scoringHostNote').style.display = 'none';
      if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

      updateLobbyCodeUI(roomId);
      syncLobbyGameModeUI(state.roomData);
      listenToRoom();
      switchScreen('lobbyScreen');
      showNotice(
        gameMode === 'party'
          ? `Party Showdown room created! Code: ${roomId} (up to 8 players)`
          : `Room created! Code: ${roomId}`,
        "success",
        3000
      );
    } catch(err) {
      console.error("Create room error:", err);
      showNotice("Failed to create room: " + (err?.message || "network error"), "error");
    } finally {
      if (el('setupLoader')) el('setupLoader').style.display = 'none';
    }
  };
}

if (el('joinRoomBtn')) {
  el('joinRoomBtn').onclick = async () => {
  const roomId = el('roomCodeInput').value.trim().toUpperCase();
  if(!roomId) return showNotice("Please enter a room code.", "warning");
  if(roomId.length !== 5) return showNotice("Room code must be 5 letters (e.g. ABCDE).", "warning");
  try {
    const ok = await authenticate();
    if(!ok) return showNotice("Could not connect to authentication service.", "error");
    const fb = await loadFirebase();
    if(!fb) return showNotice("Could not initialize connection.", "error");

    const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', roomId);
    const snap = await fb.getDoc(roomRef);
    if(!snap.exists()) return showNotice(`Room "${roomId}" was not found. Please verify the code.`, "error");

    const data = snap.data();
    const isPartyRoom = data.gameMode === 'party';
    const maxPlayers = isPartyRoom ? 8 : 4;
    if(data.players && data.players.length >= maxPlayers) return showNotice(`This room is already full (maximum ${maxPlayers} players).`, "warning");
    if(data.status !== 'lobby') return showNotice("This room has already started its studio session.", "warning");

    const existingCount = Array.isArray(data.players) ? data.players.length : 1;
    const inputVal = el('playerNameInput')?.value.trim();
    const name = inputVal || getAnonymousPlayerName(existingCount);

    const color = PLAYER_COLORS[existingCount % PLAYER_COLORS.length];
    state.me = { id: state.uid, name, color, ready: false };
    state.roomId = roomId;
    state.isHost = false;
    state.isSingleplayer = false;
    state.gameMode = isPartyRoom ? 'party' : 'coop';
    state.scoringMode = Boolean(data.scoringMode);
    state.roomData = { ...data, players: [...data.players, state.me] };

    if(el('scoringToggle')) {
      el('scoringToggle').checked = state.scoringMode;
      el('scoringToggle').disabled = true;
    }
    if(el('scoringHostNote')) {
      el('scoringHostNote').style.display = 'block';
      el('scoringHostNote').textContent = 'Host controls scoring mode';
    }
    if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

    updateLobbyCodeUI(data.id || roomId);
    syncLobbyGameModeUI(state.roomData);
    renderLobbyPlayers(state.roomData.players, data.hostId);
    el('lobbyGuestUI').style.display = 'block';
    listenToRoom();
    switchScreen('lobbyScreen');
    showNotice(isPartyRoom ? `Joined Party Showdown ${roomId}!` : `Joined room ${roomId}!`, "success", 2500);
    multiplayer.api.announcePlayer(state.roomId, state.me).catch(error => {
      console.error('Join room sync error:', error);
    });
  } catch(error) {
    console.error('Join room error:', error);
    showNotice("Could not join that room: " + (error?.message || "network error"), "error");
  } finally {
    if (el('setupLoader')) el('setupLoader').style.display = 'none';
  }
  };
}

function listenToRoom(){
  if(state.roomEventUnsub) state.roomEventUnsub();
  state.roomEventUnsub = multiplayer.api.onRoomEvent(state.roomId, handleRoomEvent);
  loadFirebase().then(fb => {
    if(!fb) return;
    const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
    state.unsubRoom = fb.onSnapshot(roomRef, (snap) => {
      if(!snap.exists()) return;
      const data = snap.data();
      state.roomData = data;
      if (data.gameMode) {
        state.gameMode = data.gameMode === 'party' ? 'party' : 'coop';
      }
      
      // Update Lobby UI
      updateLobbyCodeUI(data.id || '');
      syncLobbyGameModeUI(data);
      renderLobbyPlayers(data.players || [], data.hostId);

      // Sync scoring mode from room doc
      if (typeof data.scoringMode === 'boolean') {
        state.scoringMode = data.scoringMode;
        if (el('scoringToggle')) {
          el('scoringToggle').checked = state.scoringMode;
          el('scoringToggle').disabled = !state.isHost;
        }
        if (el('scoringHostNote')) {
          el('scoringHostNote').style.display = state.isHost ? 'none' : 'block';
        }
        if (el('scoreModeBadge')) {
          el('scoreModeBadge').classList.toggle('active', state.scoringMode);
        }
        if (el('studioScoreModeBadge')) {
          el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';
        }
        if (el('studioScreen')?.classList.contains('active')) {
          updateLaneScoreDisplay(state.fragments[state.currentIndex]);
          renderFragmentList();
          renderStudioPlayerList();
        }
      }

      if(data.status === 'lobby'){
        if(state.isHost){
          if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'block';
          const allReady = (data.players || []).length > 0 && data.players.every(p => p.ready);
          if (el('startStudioBtn')) el('startStudioBtn').disabled = !allReady || !data.videoName;
        } else {
          if (el('lobbyGuestUI')) el('lobbyGuestUI').style.display = 'block';
          if(data.videoName && !state.me?.ready){
            if (el('guestWaitText')) el('guestWaitText').style.display = 'none';
            if (el('guestMatchUI')) el('guestMatchUI').style.display = 'block';
            if (el('reqFileName')) el('reqFileName').textContent = data.videoName;
            syncHostVideo(data);
          } else if (state.me?.ready) {
            if (el('guestMatchUI')) el('guestMatchUI').style.display = 'none';
            if (el('guestWaitText')) {
              el('guestWaitText').style.display = 'block';
              el('guestWaitText').textContent = "File synced! Waiting for host to start...";
            }
          }
        }
      } else if (data.status === 'studio' && !el('studioScreen')?.classList.contains('active')) {
        enterStudio();
      }
      
      // If in studio, sync fragments and player list without overriding active line
      if(data.status === 'studio'){
        renderStudioPlayerList();
        if(Array.isArray(data.fragments) && data.fragments.length > 0){
          syncFragmentsFromDB(data.fragments);
        }
        if (isPartyMode() && typeof syncPartyStateFromRoom === 'function') {
          syncPartyStateFromRoom(data);
        }
      }
    }, (err) => console.error("Room sync error", err));
  });
}

async function syncHostVideo(roomData){
  if(state.videoSyncing || state.videoSyncedName === roomData.videoName) return;
  state.videoSyncing = true;
  state.syncProgress = 0;
  if (el('reqFileName')) el('reqFileName').textContent = roomData.videoName;
  if (el('guestSyncStatusMsg')) el('guestSyncStatusMsg').textContent = 'Connecting to host video stream...';

  const guestStepper = createProgressStepper({
    fillEl: el('syncProgressFill'),
    textEl: el('syncProgressText'),
    textSuffix: '%',
    initial: 0,
    minStepMs: 6,
    maxStepMs: 14,
    onStep: (pct) => {
      el('guestMatchUI')?.querySelector('.sync-progress')?.setAttribute('aria-valuenow', pct);
      if (pct >= 95) {
        if (el('guestSyncStatusMsg')) el('guestSyncStatusMsg').textContent = 'Finalizing audio buffer cache...';
      } else if (pct > 0) {
        if (el('guestSyncStatusMsg')) el('guestSyncStatusMsg').textContent = `Downloading video stream... (${pct}%)`;
      }
      if (pct === 0 || pct === 100 || pct >= state.syncProgress + 3) {
        state.syncProgress = pct;
        multiplayer.api.announcePlayer(state.roomId, { ...state.me, ready: pct >= 100, syncProgress: pct }).catch(() => {});
      }
    }
  });

  try {
    state.file = await multiplayer.api.downloadVideo(state.roomId, progress => {
      guestStepper.setTarget(progress);
    });
    await guestStepper.finish(100);

    if (el('syncProgressText')) el('syncProgressText').textContent = '100% - Ready';
    if (el('guestSyncStatusMsg')) el('guestSyncStatusMsg').textContent = 'Video cached! Ready to enter studio.';
    state.videoSyncedName = roomData.videoName;
    if (state.me) state.me.ready = true;
    const fb = await loadFirebase();
    if(fb){
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      const updatedPlayers = (state.roomData?.players || []).map(p => p.id === state.uid ? {...p, ready: true, syncProgress: 100} : p);
      state.roomData = { ...state.roomData, players: updatedPlayers };
      await fb.updateDoc(roomRef, { players: updatedPlayers }).catch(() => {});
    }
    if (state.me) {
      await multiplayer.api.announcePlayer(state.roomId, state.me = { ...state.me, ready: true, syncProgress:100 });
    }
  } catch(error) {
    guestStepper.stop();
    console.error('Host video sync error:', error);
    if (el('guestSyncStatusMsg')) el('guestSyncStatusMsg').textContent = 'Network sync interrupted. Retrying automatically...';
    showNotice('Could not download the host video. Retrying shortly.', 'warning');
  } finally {
    state.videoSyncing = false;
  }
}

// Host File Selection & Drag-and-Drop
async function handleHostFile(file){
  if(!file) return;
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|ogg)$/i.test(file.name);
  if(!isVideo){
    return showNotice("Please choose a valid video file (MP4, WebM, or MOV).", "error");
  }
  if(file.size > 250 * 1024 * 1024){
    showNotice("Large file detected (>250MB). Upload and audio processing may take longer.", "warning");
  }

  state.file = file;
  el('hostDropzone').textContent = `Selected: ${file.name}`;

  // Always ensure state.roomData is initialized
  if(!state.roomData) {
    state.roomData = {
      id: state.roomId || (isSoloSession() ? 'LOCAL' : 'SOLO'),
      hostId: state.uid || 'local_player',
      players: state.players || (state.me ? [state.me] : []),
      status: 'lobby',
      videoName: file.name,
      videoSize: file.size,
      scoringMode: state.scoringMode,
      fragments: state.fragments || []
    };
  } else {
    state.roomData.videoName = file.name;
    state.roomData.videoSize = file.size;
  }

  if (el('startStudioBtn')) el('startStudioBtn').disabled = false;

  if(isSoloSession()){
    showNotice(`Loaded "${file.name}" for solo session.`, "success", 2500);
    return;
  }

  const fb = await loadFirebase();
  if(!fb) return showNotice("Connection service unavailable. Please retry.", "error");

  let uploadStepper = null;
  try {
    el('hostDropzone').textContent = `Selected: ${file.name}`;
    if (el('hostUploadUI')) {
      el('hostUploadUI').style.display = 'block';
      if (el('hostUploadFileName')) el('hostUploadFileName').textContent = file.name;
      if (el('hostUploadStatusMsg')) el('hostUploadStatusMsg').textContent = 'Uploading video clip to room mesh...';
      uploadStepper = createProgressStepper({
        fillEl: el('hostUploadProgressFill'),
        textEl: el('hostUploadProgressText'),
        textSuffix: '%',
        initial: 0,
        minStepMs: 6,
        maxStepMs: 14
      });
    }
    await multiplayer.api.uploadVideo(state.roomId, file, (progress) => {
      if (uploadStepper) uploadStepper.setTarget(progress);
    });
    if (uploadStepper) {
      await uploadStepper.finish(100);
      if (el('hostUploadProgressText')) el('hostUploadProgressText').textContent = '100% - Ready';
      if (el('hostUploadStatusMsg')) el('hostUploadStatusMsg').textContent = 'Video uploaded & distributed to guests!';
    } else {
      if (el('hostUploadProgressFill')) el('hostUploadProgressFill').style.width = '100%';
      if (el('hostUploadProgressText')) el('hostUploadProgressText').textContent = '100% - Ready';
    }
    showNotice(`Video uploaded! Waiting for guests to sync.`, "success", 3000);
  } catch(error) {
    if (uploadStepper) uploadStepper.stop();
    console.error('Host video upload error:', error);
    state.file = null;
    el('hostDropzone').textContent = 'Click or drop a video file here';
    if (el('hostUploadUI')) el('hostUploadUI').style.display = 'none';
    return showNotice('Failed to upload video to the room: ' + (error?.message || 'network error'), 'error');
  }

  try {
    const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
    const currentPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    const updatedPlayers = currentPlayers.map(p => p.id === state.uid ? {...p, ready: true} : p);
    if(!updatedPlayers.some(p => p.id === state.uid) && state.me){
      updatedPlayers.push({ ...state.me, ready: true });
    }
    if(state.me) state.me.ready = true;

    try {
      await fb.updateDoc(roomRef, {
        videoName: file.name,
        videoSize: file.size,
        players: updatedPlayers
      });
    } catch(upErr) {
      await fb.setDoc(roomRef, {
        id: state.roomId,
        hostId: state.uid,
        videoName: file.name,
        videoSize: file.size,
        scoringMode: state.scoringMode,
        players: updatedPlayers,
        status: 'lobby',
        fragments: state.fragments || []
      }, { merge: true });
    }
  } catch(dbErr) {
    console.error('Failed to update room metadata:', dbErr);
    showNotice('Failed to update room status. Please try re-selecting the file.', 'error');
  }
}

if (el('hostDropzone')) {
  el('hostDropzone').onclick = () => el('hostFileInput')?.click();

  ['dragenter', 'dragover'].forEach(eventName => {
    el('hostDropzone').addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el('hostDropzone').classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    el('hostDropzone').addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el('hostDropzone').classList.remove('drag-over');
    });
  });

  el('hostDropzone').addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el('hostDropzone').classList.remove('drag-over');
    const dt = e.dataTransfer;
    if(dt && dt.files && dt.files.length > 0){
      handleHostFile(dt.files[0]);
    }
  });
}

if (el('hostFileInput')) {
  el('hostFileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    handleHostFile(file);
  };
}

if (el('startStudioBtn')) {
  el('startStudioBtn').onclick = async () => {
    if (isSoloSession()) {
      if(!state.file){
        return showNotice("Please select a video file before starting studio.", "warning");
      }
      if (!state.roomData) {
        state.roomData = {
          id: state.roomId || 'LOCAL',
          hostId: state.uid || 'local_player',
          players: state.players || (state.me ? [state.me] : []),
          status: 'studio',
          videoName: state.file.name,
          videoSize: state.file.size,
          scoringMode: state.scoringMode,
          fragments: state.fragments || []
        };
      } else {
        state.roomData.status = 'studio';
      }
      enterStudio();
      return;
    }
    try {
      const fb = await loadFirebase();
      if(!fb) return showNotice("Connection lost. Please refresh.", "error");
      if(!state.file && !state.roomData?.videoName){
        return showNotice("Please upload a video clip before starting the studio.", "warning");
      }
      if (!state.roomData) {
        state.roomData = {
          id: state.roomId,
          hostId: state.uid,
          players: state.players || (state.me ? [state.me] : []),
          status: 'studio',
          videoName: state.file?.name,
          videoSize: state.file?.size,
          scoringMode: state.scoringMode,
          gameMode: state.gameMode,
          fragments: state.fragments || []
        };
      } else {
        state.roomData.status = 'studio';
      }
      if (isPartyMode()) {
        const playerCount = (state.roomData?.players || []).length;
        if (playerCount < 4) {
          showNotice(`Starting Party Showdown with ${playerCount} player${playerCount === 1 ? '' : 's'} (4–8 recommended).`, 'info', 2800);
        }
      }
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      try {
        await fb.updateDoc(roomRef, { status: 'studio', gameMode: state.gameMode });
      } catch(upErr) {
        await fb.setDoc(roomRef, {
          id: state.roomId,
          hostId: state.uid,
          players: state.players || (state.me ? [state.me] : []),
          status: 'studio',
          videoName: state.file?.name || state.roomData?.videoName || '',
          videoSize: state.file?.size || state.roomData?.videoSize || 0,
          scoringMode: state.scoringMode,
          gameMode: state.gameMode,
          fragments: state.fragments || []
        }, { merge: true });
      }
      enterStudio();
    } catch(err) {
      console.error("Start studio error:", err);
      showNotice("Could not start studio session: " + (err?.message || "network error"), "error");
    }
  };
}

async function enterStudio(){
  switchScreen('studioScreen');
  el('studioRoomBadge').textContent = state.isSingleplayer
    ? 'Mode: Solo'
    : (isPartyMode() ? `Party · ${state.roomId}` : `Room: ${state.roomId}`);
  if (el('studioScoreModeBadge')) {
    el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';
  }
  
  renderStudioPlayerList();
  
  el('editToggleInput').disabled = !state.isHost;
  el('undoBtn').style.display = state.isHost ? 'inline-flex' : 'none';
  el('assignPanel').style.display = (state.isSingleplayer || isPartyMode()) ? 'none' : 'flex';
  if (typeof syncPartyModeClasses === 'function') syncPartyModeClasses();
  const simplePref = settings.get('simpleMode');
  const shouldSimple = isPartyMode()
    ? false
    : ((simplePref === true || simplePref === false)
      ? simplePref
      : (!state.isSingleplayer && !state.isHost));
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('simple-mode', Boolean(shouldSimple));
  }
  if (el('settingSimpleMode')) el('settingSimpleMode').checked = Boolean(shouldSimple);
  if (el('simpleModeBadge')) {
    const isAuto = simplePref !== true && simplePref !== false;
    el('simpleModeBadge').textContent = isAuto
      ? (shouldSimple ? 'Auto (Guest)' : 'Auto (Full)')
      : (shouldSimple ? 'On (Simple)' : 'Off (Full)');
    el('simpleModeBadge').classList.toggle('active', Boolean(shouldSimple));
  }
  
  const video = el('mainVideo');
  if (video) {
    video.onerror = () => {
      const err = video.error;
      let msg = "Video playback encountered an issue.";
      if (err) {
        if (err.code === 1) msg = "Video loading was aborted.";
        else if (err.code === 2) msg = "Network error while loading video.";
        else if (err.code === 3) msg = "Video decoding error or corrupted format.";
        else if (err.code === 4) msg = "Video format or codec not supported by this browser.";
      }
      showNotice(msg, "error");
    };
  }

  // Immediately ensure video element has a source so playback is never blocked
  if (state.file) {
    if (state.videoURL) URL.revokeObjectURL(state.videoURL);
    state.videoURL = URL.createObjectURL(state.file);
    video.src = state.videoURL;
  } else if (state.roomId && !state.isSingleplayer) {
    // Direct stream fallback for instant playback and seek
    video.src = `/api/rooms/${state.roomId}/video`;
  }
  
  if (video.src) {
    try { video.load(); } catch(e) {}
  }

  // Pre-request microphone access so it doesn't interrupt the user's first take
  try {
    if(!state.micStream) {
      state.micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    }
  } catch(err) {
    console.warn("Mic access not granted at startup. Will prompt again on record.");
  }

  // If guest enters studio and video file is not yet locally downloaded, download it now for buffer extraction
  if(!state.file && state.roomId && !state.isSingleplayer){
    if (el('monitorLoading')) el('monitorLoading').style.display = 'flex';
    if (el('monitorLoadingText')) el('monitorLoadingText').textContent = 'Syncing video from host...';
    if (el('monitorLoadingSub')) el('monitorLoadingSub').textContent = 'Downloading media for timeline playback';
    const monitorDownloadStepper = createProgressStepper({
      fillEl: el('monitorLoadingBarFill'),
      textEl: el('monitorLoadingPercent'),
      textSuffix: '%',
      initial: 0,
      minStepMs: 6,
      maxStepMs: 14,
      onStep: (pct) => {
        if (el('monitorLoadingText')) el('monitorLoadingText').textContent = `Syncing video... ${pct}%`;
      }
    });
    try {
      state.file = await multiplayer.api.downloadVideo(state.roomId, (progress) => {
        monitorDownloadStepper.setTarget(progress);
      });
      await monitorDownloadStepper.finish(100);
      state.videoSyncedName = state.roomData?.videoName || 'clip.mp4';
      if(state.me) state.me.ready = true;
      // Re-point video to local blob for best seek performance
      if (state.file) {
        if(state.videoURL) URL.revokeObjectURL(state.videoURL);
        state.videoURL = URL.createObjectURL(state.file);
        video.src = state.videoURL;
        video.load();
      }
    } catch(err) {
      monitorDownloadStepper.stop();
      console.warn('Background download completed via stream fallback:', err);
    }
  }

  // Wait for video metadata to have accurate duration
  if (video.src) {
    await new Promise(r => {
      if (video.readyState >= 1) return r();
      video.onloadedmetadata = () => r();
      setTimeout(r, 1200);
    });
    state.duration = video.duration || (await forceDuration()) || 10;
  }

  // Extract master buffer & audio envelope for waveforms & vocals
  if(state.file){
    let audioExtractStepper = null;
    try {
      if (el('monitorLoading')) el('monitorLoading').style.display = 'flex';
      if (el('monitorLoadingText')) el('monitorLoadingText').textContent = 'Analyzing audio timeline...';
      if (el('monitorLoadingSub')) el('monitorLoadingSub').textContent = 'Extracting speech dynamics, waveform & vocal bed';

      audioExtractStepper = createProgressStepper({
        fillEl: el('monitorLoadingBarFill'),
        textEl: el('monitorLoadingPercent'),
        textSuffix: '%',
        initial: 0,
        minStepMs: 6,
        maxStepMs: 12
      });

      audioExtractStepper.setTarget(30);
      const ctx = ensureCtx();
      if(ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const arr = await state.file.arrayBuffer();

      audioExtractStepper.setTarget(65);
      state.masterBuffer = await ctx.decodeAudioData(arr.slice(0));

      audioExtractStepper.setTarget(85);
      state.envelope = buildEnvelope(state.masterBuffer, 50);
      state.backgroundBuffer = buildVocalReducedBuffer(state.masterBuffer);
      if(!state.backgroundBuffer){
        showNotice("This clip's audio is mono, so the original voice can't be separated from the background. The full original audio will play under any un-dubbed lines instead.");
      }

      await audioExtractStepper.finish(100);
      await new Promise(r => setTimeout(r, 160));
    } catch(e) {
      if (audioExtractStepper) audioExtractStepper.stop();
      console.warn("Waveform extraction notice:", e);
    } finally {
      if (el('monitorLoading')) el('monitorLoading').style.display = 'none';
    }
  } else {
    if (el('monitorLoading')) el('monitorLoading').style.display = 'none';
  }

  const existingFrags = (state.roomData?.fragments && state.roomData.fragments.length > 0)
    ? state.roomData.fragments
    : (Array.isArray(state.fragments) && state.fragments.length > 0)
      ? state.fragments
      : null;

  if (state.isHost && (!existingFrags || existingFrags.length === 0)) {
    // Host auto-segments and distributes lines across players in Co-op mode (free-for-all in Party Showdown)
    const initialFrags = autoSegment();
    const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    if(!state.isSingleplayer && !isPartyMode() && roomPlayers.length > 0){
      initialFrags.forEach((f, idx) => {
        const assignedPlayer = roomPlayers[idx % roomPlayers.length];
        if(assignedPlayer && assignedPlayer.id){
          f.assigned = [assignedPlayer.id];
        }
      });
    }
    state.fragments = initialFrags;
    if(state.roomData) state.roomData.fragments = initialFrags;
    renderMasterCanvas();
    renderFragmentList();
    if(state.fragments.length > 0) selectFragment(0, true);

    if (!state.isSingleplayer) {
      const fb = await loadFirebase();
      if(fb && state.roomId){
        const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
        try {
          await fb.updateDoc(roomRef, { fragments: initialFrags });
        } catch(e) {
          console.warn("Fragment sync:", e);
        }
        sendPlaybackEvent({ action: 'sync-fragments', fragments: initialFrags });
      }
      if (isPartyMode() && state.roomId) {
        multiplayer.api.partyAction(state.roomId, { action: 'init-party', actorUid: state.uid }).catch((e) => {
          console.warn('Init party action failed:', e);
        });
      }
    }
  } else {
    // Preserve existing fragments from restored session or room state
    if (existingFrags && existingFrags.length > 0) {
      state.fragments = [...existingFrags];
      if (state.roomData) state.roomData.fragments = [...existingFrags];
      renderMasterCanvas();
      renderFragmentList();
      if (isPartyMode()) {
        const partyIdx = typeof state.roomData?.party?.fragmentIndex === 'number' ? state.roomData.party.fragmentIndex : 0;
        state.currentIndex = Math.max(0, Math.min(state.fragments.length - 1, partyIdx));
      } else {
        const myLineIdx = state.fragments.findIndex(f => Array.isArray(f.assigned) && f.assigned.includes(state.uid));
        state.currentIndex = myLineIdx >= 0 ? myLineIdx : 0;
      }
      if(state.fragments.length > 0) selectFragment(state.currentIndex, true);

      if (!state.isSingleplayer && state.isHost) {
        const fb = await loadFirebase();
        if(fb && state.roomId){
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          try {
            await fb.updateDoc(roomRef, { fragments: state.fragments });
          } catch(e) {
            console.warn("Restored fragment sync:", e);
          }
        }
        if (isPartyMode() && state.roomId && !state.roomData?.party) {
          multiplayer.api.partyAction(state.roomId, { action: 'init-party', actorUid: state.uid }).catch(() => {});
        }
      }
    }
  }

  if (!state.isSingleplayer) {
    listenToTakes();
  }
  requestAnimationFrame(() => {
    renderMasterCanvas();
    renderFragmentList();
    if(state.fragments[state.currentIndex]) {
      drawWave(state.fragments[state.currentIndex]);
      updateLaneScoreDisplay(state.fragments[state.currentIndex]);
      updateActiveLineTranscriptUI(state.fragments[state.currentIndex]);
    } else {
      updateActiveLineTranscriptUI();
    }
    updateMonitorSubtitle();
    checkRecordAbility();
    if (isPartyMode() && typeof syncPartyUI === 'function') {
      syncPartyUI();
    }
    persistCurrentSession();

    // Automatically run Voice-to-Text for any un-transcribed fragments once audio is decoded
    if ((state.isHost || state.isSingleplayer) && state.masterBuffer && state.fragments.length > 0) {
      autoTranscribeMissingFragments({ silent: true });
    }
  });
}

function forceDuration(){
  const v = el('mainVideo');
  return new Promise((resolve) => {
    v.currentTime = 1e9;
    const onUpdate = () => {
      v.removeEventListener('timeupdate', onUpdate);
      const d = v.duration;
      v.currentTime = 0;
      resolve(isFinite(d) ? d : 0);
    };
    v.addEventListener('timeupdate', onUpdate);
    setTimeout(() => resolve(v.duration || 0), 1000);
  });
}

function buildEnvelope(buffer, targetRate){
  const data = buffer.getChannelData(0); // Simplified to ch 0 for speed
  const win = Math.max(1, Math.floor(buffer.sampleRate / targetRate));
  const n = Math.ceil(data.length / win);
  const env = new Float32Array(n);
  for(let i=0; i<n; i++){
    let sum = 0;
    let a = i*win, b = Math.min(a+win, data.length);
    for(let j=a; j<b; j++){ sum += data[j]*data[j]; }
    env[i] = Math.sqrt(sum / Math.max(1, b-a));
  }
  return { env, rate: targetRate };
}

/* Vocal-reduction via center-channel cancellation (L-R).
   This is the classic "karaoke trick": content panned dead-center
   (often lead vocals/dialogue) is correlated across channels and
   cancels out, while off-center content (music, ambience) survives.
   It only works on true stereo sources, and it's a heuristic, not
  real source separation -- some background elements will thin out
   too, and mono clips can't be processed this way at all. */
function buildVocalReducedBuffer(buffer){
  if(!buffer || buffer.numberOfChannels < 2) return null;
  const ctx = ensureCtx();
  const len = buffer.length;
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const out = ctx.createBuffer(2, len, buffer.sampleRate);
  const diff = new Float32Array(len);
  for(let i=0; i<len; i++){ diff[i] = (L[i] - R[i]) * 0.9; }
  out.getChannelData(0).set(diff);
  out.getChannelData(1).set(diff);
  return out;
}

function sliceMasterBuffer(start, end){
  if(!state.masterBuffer) return null;
  const ctx = ensureCtx();
  const buf = state.masterBuffer;
  const sr = buf.sampleRate;
  const startSample = Math.max(0, Math.floor(start*sr));
  const endSample = Math.min(buf.length, Math.ceil(end*sr));
  const len = Math.max(1, endSample - startSample);
  const out = ctx.createBuffer(buf.numberOfChannels, len, sr);
  for(let c=0; c<buf.numberOfChannels; c++){
    out.getChannelData(c).set(buf.getChannelData(c).subarray(startSample, startSample+len));
  }
  return out;
}

function autoSegment(){
  const dur = (state.duration && isFinite(state.duration) && state.duration > 0)
    ? state.duration
    : (el('mainVideo')?.duration || 10);

  if(!state.envelope){
    // If envelope is not ready yet, create evenly spaced 3.5s lines across clip duration
    const slices = [];
    const step = 3.5;
    for(let t=0; t<dur; t+=step){
      const s = t, e = Math.min(dur, t+step);
      if(e - s > 0.5) slices.push([s, e]);
    }
    if(slices.length === 0) slices.push([0, dur]);
    return slices.map(([s,e], i) => ({
      id: 'f_'+i+'_'+Math.random().toString(36).slice(2,6),
      start: s,
      end: e,
      assigned: state.isSingleplayer ? [state.uid] : []
    }));
  }

  const { env, rate } = state.envelope;
  const opts = { minLen: 1.0, maxLen: 8.0, silence: 0.35, threshRatio: 0.08 };
  
  const sorted = new Float32Array(env).sort();
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 0; // Robust max
  const thresh = peak * opts.threshRatio;
  const silFrames = Math.max(1, Math.round(opts.silence * rate));

  const cuts = [0];
  let silRun = 0, lastCut = 0;
  for(let i=0; i<env.length; i++){
    if(env[i] < thresh) silRun++; else silRun = 0;
    if(silRun >= silFrames){
      const cutT = (i/rate) - (opts.silence * 0.4);
      if(cutT - lastCut >= opts.minLen){
        cuts.push(cutT); lastCut = cutT; silRun = 0;
      }
    }
  }
  cuts.push(dur);
  
  let segs = [];
  for(let i=0; i<cuts.length-1; i++){
    if(cuts[i+1] - cuts[i] > 0.05) segs.push([cuts[i], cuts[i+1]]);
  }

  let refined = [];
  for(const [s,e] of segs){
    const len = e - s;
    if(len <= opts.maxLen){ refined.push([s,e]); continue; }
    const parts = Math.ceil(len / opts.maxLen);
    const step = len / parts;
    for(let k=0; k<parts; k++) refined.push([s + k*step, k === parts-1 ? e : s + (k+1)*step]);
  }

  return refined.map(([s,e], i) => ({
    id: 'f_'+i+'_'+Math.random().toString(36).slice(2,6),
    start: s,
    end: e,
    assigned: state.isSingleplayer ? [state.uid] : [],
    transcript: ''
  }));
}

function syncFragmentsFromDB(dbFrags){
  if(!Array.isArray(dbFrags) || dbFrags.length === 0) return;
  state.fragments = dbFrags;
  if (isPartyMode() && !(state.isHost && state.editMode)) {
    const partyIdx = getPartyState()?.fragmentIndex;
    if (typeof partyIdx === 'number') {
      state.currentIndex = Math.max(0, Math.min(state.fragments.length - 1, partyIdx));
    }
  }
  if(state.currentIndex >= state.fragments.length){
    state.currentIndex = Math.max(0, state.fragments.length - 1);
  }
  renderMasterCanvas();
  renderFragmentList();
  updateMasterFragmentsDuration();
  const f = state.fragments[state.currentIndex];
  if(f){
    renderAssignmentUI(f);
    checkRecordAbility();
    drawWave(f);
    updateActiveLineTranscriptUI(f);
  }
}

async function broadcastFragments(fragments = state.fragments) {
  if (state.roomData) state.roomData.fragments = fragments;
  if (!isSoloSession() && state.roomId) {
    sendPlaybackEvent({ action: 'sync-fragments', fragments });
    const fb = await loadFirebase();
    if (fb) {
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      await fb.updateDoc(roomRef, { fragments }).catch(() => {});
    }
  }
}

function updateMonitorSubtitle() {
  const overlay = el('monitorSubtitleOverlay');
  const textEl = el('monitorSubtitleText');
  if (!overlay || !textEl) return;

  if (!settings.get('showSubtitles')) {
    overlay.style.display = 'none';
    return;
  }

  const isActive = Boolean(state.isPlaying || state.paused);
  const frag = state.pb?.frag || state.fragments[state.currentIndex];
  const text = (frag && typeof frag.transcript === 'string') ? frag.transcript.trim() : '';

  if (isActive && text) {
    textEl.textContent = text;
    overlay.style.display = 'block';
  } else {
    overlay.style.display = 'none';
  }
}

function updateActiveLineTranscriptUI(f = state.fragments[state.currentIndex]) {
  const container = el('activeLineTranscriptText');
  const lineBadge = el('masterTranscriptLineBadge');
  const isSimple = typeof document !== 'undefined' && document.body.classList.contains('simple-mode');
  if (lineBadge) {
    lineBadge.textContent = `Line ${state.currentIndex + 1}:`;
  }
  if (!container) return;
  container.contentEditable = isSimple ? 'false' : 'true';
  if (f && typeof f.transcript === 'string' && f.transcript.trim()) {
    container.textContent = f.transcript.trim();
    container.style.fontStyle = 'normal';
    container.style.color = '#F5EDFF';
  } else {
    container.textContent = isSimple
      ? 'Ready to record this line — press Listen or Record'
      : 'Click Voice-to-Text or click to type script...';
    container.style.fontStyle = 'italic';
    container.style.color = 'var(--text-faint)';
  }
  updateMonitorSubtitle();
}

/**
 * Converts an AudioBuffer channel segment into a lightweight 16kHz mono WAV base64 string
 * for optimal speech-to-text recognition payload.
 */
function audioBufferToWavBase64(audioBuffer, targetSampleRate = 16000) {
  if (!audioBuffer) return null;
  const numChannels = audioBuffer.numberOfChannels;
  const originalSampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  if (length === 0) return null;

  // Mix down to mono
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numChannels;
    }
  }

  // Downsample to targetSampleRate (16kHz)
  const ratio = originalSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(length / ratio));
  const resampled = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origIndex = i * ratio;
    const i0 = Math.floor(origIndex);
    const i1 = Math.min(length - 1, i0 + 1);
    const frac = origIndex - i0;
    resampled[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }

  // Quantize Float32 to 16-bit PCM
  const pcm16 = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const s = Math.max(-1, Math.min(1, resampled[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const byteRate = targetSampleRate * 2;
  const blockAlign = 2;
  const wavBuffer = new ArrayBuffer(44 + pcm16.byteLength);
  const view = new DataView(wavBuffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm16.byteLength, true);

  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcm16.buffer));

  let binary = '';
  const bytes = new Uint8Array(wavBuffer);
  const totalBytes = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < totalBytes; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(totalBytes, i + chunk)));
  }
  return btoa(binary);
}

/**
 * Encodes an AudioBuffer (mono or stereo) into a 16-bit PCM WAV Blob.
 */
function audioBufferToWavBlob(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) return null;
  const numChannels = Math.min(2, Math.max(1, audioBuffer.numberOfChannels || 1));
  const sampleRate = audioBuffer.sampleRate || 48000;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = length * blockAlign;

  const wavBuffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(wavBuffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

let lastFinalDownloadUrl = null;
let lastVocalsDownloadUrl = null;
let isTranscribing = false;
const autoTranscribedFragKeys = new Set();
let autoTranscribeKeyMissing = false;
let autoTranscribeCooldownUntil = 0;

function getFragTranscribeKey(f) {
  if (!f) return '';
  return `${f.id}:${Number(f.start || 0).toFixed(2)}:${Number(f.end || 0).toFixed(2)}`;
}

function isAudioBufferSilent(audioBuffer, peakThreshold = 0.0004) {
  if (!audioBuffer || audioBuffer.length === 0) return true;
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) >= peakThreshold) return false;
    }
  }
  return true;
}

async function autoTranscribeMissingFragments({ silent = true } = {}) {
  if (autoTranscribeKeyMissing || isTranscribing || Date.now() < autoTranscribeCooldownUntil) return;
  if (!state.masterBuffer || !Array.isArray(state.fragments) || state.fragments.length === 0) return;

  const hasMissing = state.fragments.some(f => {
    const hasText = typeof f.transcript === 'string' && f.transcript.trim().length > 0;
    return !hasText && !autoTranscribedFragKeys.has(getFragTranscribeKey(f));
  });
  if (!hasMissing) return;

  await transcribeAllFragments({ onlyMissing: true, silent });
}

async function transcribeActiveLine() {
  if (isTranscribing) return;
  const f = state.fragments[state.currentIndex];
  if (!f) return showNotice("No line selected.", "warning");
  if (!state.masterBuffer) return showNotice("Audio waveform not yet loaded. Please wait.", "warning");

  const seg = sliceMasterBuffer(f.start, f.end);
  if (!seg) return showNotice("Could not extract line audio.", "error");

  const base64Wav = audioBufferToWavBase64(seg, 16000);
  if (!base64Wav) return showNotice("Audio slice is empty.", "warning");

  const v2tBtn = el('voiceToTextBtn');
  const btnLabel = el('voiceToTextBtnText');
  const statusPill = el('transcribeStatusPill');
  const statusText = el('transcribeStatusText');
  const transcriptTextEl = el('activeLineTranscriptText');

  isTranscribing = true;
  if (v2tBtn) {
    v2tBtn.classList.add('is-transcribing');
    v2tBtn.disabled = true;
  }
  if (btnLabel) btnLabel.textContent = 'Transcribing...';
  if (statusPill) statusPill.style.display = 'inline-flex';
  if (statusText) statusText.textContent = '0%';
  if (transcriptTextEl) {
    transcriptTextEl.textContent = 'Transcribing spoken speech...';
    transcriptTextEl.style.fontStyle = 'italic';
  }

  const stepper = createProgressStepper({
    onStep: (pct) => {
      if (statusText) statusText.textContent = `${pct}%`;
    },
    minStepMs: 8,
    maxStepMs: 16
  });

  try {
    stepper.setTarget(45);
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64Wav, mimeType: 'audio/wav' })
    });
    const data = await res.json();
    stepper.setTarget(85);

    if (data && data.keyMissing) {
      autoTranscribeKeyMissing = true;
      stepper.stop();
      updateActiveLineTranscriptUI(f);
      showNotice("Gemini API key is not configured in environment. You can click to type the line script directly.", "info", 4500);
      if (transcriptTextEl) transcriptTextEl.focus();
      return;
    }

    if (data && data.rateLimited) {
      const waitSec = data.retryAfterSec || 30;
      autoTranscribeCooldownUntil = Date.now() + waitSec * 1000;
      stepper.stop();
      updateActiveLineTranscriptUI(f);
      showNotice(data.warning || `Voice-to-Text rate limit reached. Try again in ${waitSec}s.`, "warning", 4500);
      return;
    }

    if (!res.ok) {
      throw new Error(data?.error || `HTTP error ${res.status}`);
    }

    await stepper.finish(100);
    const transcript = (data?.transcript || '').trim();
    f.transcript = transcript;
    autoTranscribedFragKeys.add(getFragTranscribeKey(f));
    updateActiveLineTranscriptUI(f);
    broadcastFragments();
    persistCurrentSession();
    showNotice(
      transcript ? `Line ${state.currentIndex + 1} transcribed!` : `No speech detected in Line ${state.currentIndex + 1}.`,
      transcript ? "success" : "info",
      3000
    );
  } catch (err) {
    stepper.stop();
    console.error("Transcribe active line error:", err);
    updateActiveLineTranscriptUI(f);
    showNotice(`Voice-to-Text: ${err?.message || 'Transcription failed'}. You can type the script directly.`, "warning", 4500);
  } finally {
    isTranscribing = false;
    if (v2tBtn) {
      v2tBtn.classList.remove('is-transcribing');
      v2tBtn.disabled = false;
    }
    if (btnLabel) btnLabel.textContent = 'Voice-to-Text';
    setTimeout(() => {
      if (statusPill) statusPill.style.display = 'none';
    }, 1500);
  }
}

async function transcribeAllFragments({ onlyMissing = false, silent = false } = {}) {
  if (isTranscribing) return;
  if (!state.fragments || state.fragments.length === 0) {
    if (!silent) showNotice("No lines available in studio to transcribe.", "warning");
    return;
  }
  if (!state.masterBuffer) {
    if (!silent) showNotice("Audio timeline is still analyzing. Please wait a moment.", "warning");
    return;
  }

  const targetFrags = onlyMissing
    ? state.fragments.filter(f => {
        const hasText = typeof f.transcript === 'string' && f.transcript.trim().length > 0;
        return !hasText && !autoTranscribedFragKeys.has(getFragTranscribeKey(f));
      })
    : [...state.fragments];

  if (targetFrags.length === 0) return;

  const v2tBtn = el('voiceToTextBtn');
  const btnLabel = el('voiceToTextBtnText');
  const statusPill = el('transcribeStatusPill');
  const statusText = el('transcribeStatusText');

  isTranscribing = true;
  if (v2tBtn) {
    v2tBtn.classList.add('is-transcribing');
    v2tBtn.disabled = true;
  }
  if (btnLabel) btnLabel.textContent = onlyMissing ? 'Auto-Transcribing...' : 'Transcribing...';
  if (statusPill) statusPill.style.display = 'inline-flex';
  if (statusText) statusText.textContent = onlyMissing ? 'Auto 0%' : '0%';

  const transcribeStepper = createProgressStepper({
    onStep: (pct) => {
      if (statusText) statusText.textContent = onlyMissing ? `Auto ${pct}%` : `Transcribing ${pct}%`;
    },
    minStepMs: 8,
    maxStepMs: 16
  });

  try {
    transcribeStepper.setTarget(10);
    const items = [];
    for (let i = 0; i < targetFrags.length; i++) {
      const f = targetFrags[i];
      const seg = sliceMasterBuffer(f.start, f.end);
      if (!seg || isAudioBufferSilent(seg)) {
        autoTranscribedFragKeys.add(getFragTranscribeKey(f));
        if (!onlyMissing) f.transcript = '';
        continue;
      }
      const base64Wav = audioBufferToWavBase64(seg, 16000);
      if (base64Wav) {
        items.push({
          id: f.id,
          key: getFragTranscribeKey(f),
          audio: base64Wav,
          mimeType: 'audio/wav'
        });
      }
    }

    if (items.length === 0) {
      transcribeStepper.stop();
      if (statusPill) statusPill.style.display = 'none';
      return;
    }

    const batchSize = 12;
    let count = 0;
    const totalBatches = Math.ceil(items.length / batchSize);

    for (let b = 0; b < totalBatches; b++) {
      const batch = items.slice(b * batchSize, (b + 1) * batchSize);
      const batchStartPct = 15 + Math.round((b / totalBatches) * 75);
      const batchEndPct = 15 + Math.round(((b + 1) / totalBatches) * 75);
      transcribeStepper.setTarget(batchStartPct);

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch.map(({ id, audio, mimeType }) => ({ id, audio, mimeType })) })
      });
      const data = await res.json();

      if (data && data.keyMissing) {
        autoTranscribeKeyMissing = true;
        transcribeStepper.stop();
        updateActiveLineTranscriptUI();
        if (!silent) {
          showNotice("Gemini API key is not configured in environment. Line scripts can be typed directly.", "info", 4500);
        }
        if (statusPill) statusPill.style.display = 'none';
        return;
      }

      if (data && data.rateLimited) {
        const waitSec = data.retryAfterSec || 30;
        autoTranscribeCooldownUntil = Date.now() + waitSec * 1000;
        transcribeStepper.stop();
        updateActiveLineTranscriptUI();
        renderFragmentList();
        if (count > 0) {
          broadcastFragments();
          persistCurrentSession();
        }
        showNotice(data.warning || `Voice-to-Text API quota reached. Try again in ${waitSec}s.`, "warning", 5000);
        if (statusPill) statusPill.style.display = 'none';
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || `HTTP error ${res.status}`);
      }

      batch.forEach(item => {
        if (item.key) autoTranscribedFragKeys.add(item.key);
      });

      const results = Array.isArray(data.results) ? data.results : [];
      results.forEach(item => {
        const f = state.fragments.find(x => x.id === item.id);
        if (f) {
          const text = (item.transcript || '').trim();
          if (text || !onlyMissing) {
            f.transcript = text;
          }
          if (text) count++;
        }
      });

      transcribeStepper.setTarget(batchEndPct);
      updateActiveLineTranscriptUI();
      renderFragmentList();
    }

    await transcribeStepper.finish(100);
    renderFragmentList();
    updateActiveLineTranscriptUI();
    broadcastFragments();
    persistCurrentSession();

    if (statusText) statusText.textContent = `${count} line${count !== 1 ? 's' : ''} ready`;
    if (!silent) {
      showNotice(`Voice-to-Text complete! Generated ${count} line script${count !== 1 ? 's' : ''}.`, "success", 4000);
    } else if (count > 0) {
      showNotice(`Auto-transcribed ${count} line${count !== 1 ? 's' : ''} from audio.`, "success", 3200);
    }
    setTimeout(() => {
      if (statusPill) statusPill.style.display = 'none';
    }, 2200);
  } catch (err) {
    transcribeStepper.stop();
    console.error("Transcribe all fragments error:", err);
    if (!silent) {
      showNotice(`Voice-to-Text error: ${err?.message || 'Check network'}`, "error", 5000);
    }
    if (statusPill) statusPill.style.display = 'none';
  } finally {
    isTranscribing = false;
    if (v2tBtn) {
      v2tBtn.classList.remove('is-transcribing');
      v2tBtn.disabled = false;
    }
    if (btnLabel) btnLabel.textContent = 'Voice-to-Text';
  }
}

// Fetch all takes for this room
function listenToTakes(){
  loadFirebase().then(fb => {
    if(!fb) return;
    const takesRef = fb.collection(db, 'artifacts', appId, 'public', 'data', 'takes_' + state.roomId);
    state.unsubTakes = fb.onSnapshot(takesRef, async (snap) => {
      for (const change of snap.docChanges()) {
        const data = change.doc.data();
        const fragId = data.fragId;
        const uid = data.uid;
        
        if(change.type === 'added' || change.type === 'modified'){
          try {
            // Convert base64 back to buffer
            const res = await fetch(data.audio);
            const arr = await res.arrayBuffer();
            const ctx = ensureCtx();
            let buffer = await ctx.decodeAudioData(arr);

            let normalized = false;
            let normalizedDb = null;
            if (settings.get('autoNormalize')) {
              const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
              const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;
              const norm = normalizeAudioBuffer(ctx, buffer, targetDb, { silenceThresholdDb: silenceFloor });
              buffer = norm.buffer;
              normalized = !norm.wasGated;
              normalizedDb = norm.normalizedPeakDb;
            }
            
            if(!state.takes[fragId]) state.takes[fragId] = {};
            state.takes[fragId][uid] = { buffer, trace: data.trace, score: data.score, normalized, normalizedDb };
          } catch(err) {
            console.error("Failed to decode remote take:", err);
          }
        }
        if(change.type === 'removed'){
          if(state.takes[fragId]) delete state.takes[fragId][uid];
        }
      }
      // Refresh UI
      renderFragmentList();
      renderStudioPlayerList();
      if(state.fragments[state.currentIndex]){
        drawWave(state.fragments[state.currentIndex]);
        updateLaneScoreDisplay(state.fragments[state.currentIndex]);
        checkRecordAbility();
      }
    }, (err) => console.error("Takes sync error", err));
  });
}

// Assignment UI updates
function renderAssignmentUI(frag){
  const container = el('assignOptsContainer');
  if(!container) return;
  container.innerHTML = '';
  if(!frag) return;

  const players = state.roomData?.players || (state.me ? [state.me] : []);
  if(players.length === 0) return;

  const isSolo = isSoloSession();
  players.forEach((p, idx) => {
    const isAssigned = Array.isArray(frag.assigned) && frag.assigned.includes(p.id);
    let pName = p.name;
    if (!pName || (isSolo && pName.startsWith('anon'))) {
      pName = isSolo ? 'Solo Dubber' : getAnonymousPlayerName(idx);
    }
    const label = document.createElement('label');
    label.className = 'assign-opt';
    label.innerHTML = `
      <input type="checkbox" value="${p.id}" ${isAssigned ? 'checked' : ''}>
      <span style="color:${p.color || '#B285F5'}">${pName}</span>
    `;
    
    label.querySelector('input').onchange = async (e) => {
      const checked = e.target.checked;
      let newAssigned = Array.isArray(frag.assigned) ? [...frag.assigned] : [];
      if(checked){
        if(newAssigned.length >= 2){
          e.target.checked = false;
          return showNotice("Max 2 players per line. Uncheck another player to assign yourself.");
        }
        if(!newAssigned.includes(p.id)) newAssigned.push(p.id);
      } else {
        newAssigned = newAssigned.filter(id => id !== p.id);
      }
      frag.assigned = newAssigned;
      
      // Update DB
      const updatedFrags = [...state.fragments];
      const fIndex = updatedFrags.findIndex(f => f.id === frag.id);
      if(fIndex > -1){
        updatedFrags[fIndex].assigned = newAssigned;
        state.fragments = updatedFrags;
        renderAssignmentUI(state.fragments[state.currentIndex]);
        renderFragmentList();
        checkRecordAbility();
        if (!state.isSingleplayer && state.roomId) {
          sendPlaybackEvent({
            action: 'update-assignments',
            fragmentId: frag.id,
            assigned: newAssigned
          });
          const fb = await loadFirebase();
          if(fb && state.roomId){
            const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
            await fb.updateDoc(roomRef, { fragments: updatedFrags });
          }
        }
      }
    };
    container.appendChild(label);
  });
}

function renderStudioPlayerList(){
  syncAsteroidPlayerColors();
  const container = el('studioPlayerList');
  if(!container) return;
  const players = state.roomData?.players || (state.me ? [state.me] : []);
  const hostId = state.roomData?.hostId;
  const isSolo = isSoloSession();

  container.innerHTML = players.map((p, idx) => {
    const act = state.playerActivities[p.id] || { activity: 'idle' };
    const isMe = p.id === state.uid;
    const isHost = p.id === hostId;
    let pName = p.name;
    if (!pName || (isSolo && pName.startsWith('anon'))) {
      pName = isSolo ? 'Solo Dubber' : getAnonymousPlayerName(idx);
    }

    let badgeClass = '';
    let badgeContent = '';

    if(act.activity === 'recording'){
      badgeClass = 'is-recording';
      const lineText = typeof act.fragIndex === 'number' ? `Line ${act.fragIndex + 1}` : 'Take';
      badgeContent = `<span class="rec-dot-pulse"></span> REC (${lineText})`;
    } else if(act.activity === 'reviewing'){
      badgeClass = 'is-playing';
      badgeContent = `▶ Playing`;
    } else if(act.activity === 'listening'){
      badgeClass = 'is-listening';
      badgeContent = `🎧 Listening`;
    } else if(act.activity === 'paused'){
      badgeClass = 'is-paused';
      badgeContent = `⏸ Paused`;
    } else {
      badgeClass = 'is-idle';
      const lineText = typeof act.fragIndex === 'number' ? `Line ${act.fragIndex + 1}` : 'Idle';
      badgeContent = lineText;
    }

    const hostTag = isHost ? '<span class="role-tag">Host</span>' : '';
    const youTag = isMe ? '<span class="you-tag">(You)</span>' : '';

    let scoreTag = '';
    if (state.scoringMode) {
      const pScores = [];
      Object.values(state.takes).forEach(takesObj => {
        if (takesObj && takesObj[p.id] && typeof takesObj[p.id].score === 'number' && takesObj[p.id].score > 0) {
          pScores.push(takesObj[p.id].score);
        }
      });
      if (pScores.length > 0) {
        const avg = Math.round(pScores.reduce((a, b) => a + b, 0) / pScores.length);
        scoreTag = `<span class="player-score-tag" title="Average wave match: ${avg}% across ${pScores.length} line(s)">★ ${avg}%</span>`;
      }
    }

    return `
      <div class="studio-player-badge ${badgeClass}" data-player-id="${p.id}" data-frag-index="${typeof act.fragIndex === 'number' ? act.fragIndex : ''}" title="Click to view ${pName}'s active line">
        <div class="p-dot" style="background:${p.color || '#B285F5'}"></div>
        <span class="p-name">${pName}${youTag}${hostTag}${scoreTag}</span>
        <span class="p-state">${badgeContent}</span>
      </div>
    `;
  }).join('');

  // Add click to jump to player's line
  container.querySelectorAll('.studio-player-badge').forEach(b => {
    b.onclick = () => {
      if (isPartyMode()) {
        showNotice("In Party Showdown, everyone plays through one line at a time!", "info", 2000);
        return;
      }
      const idxStr = b.getAttribute('data-frag-index');
      if(idxStr !== '' && idxStr !== null){
        const idx = parseInt(idxStr, 10);
        if(!isNaN(idx) && idx >= 0 && idx < state.fragments.length){
          selectFragment(idx);
        }
      }
    };
  });
}

function broadcastMyActivity(activity, fragId = null, fragIndex = state.currentIndex){
  state.playerActivities[state.uid] = {
    activity,
    fragId,
    fragIndex,
    playerName: state.me?.name || 'Player',
    updatedAt: Date.now()
  };
  renderStudioPlayerList();

  if(!state.isSingleplayer && state.roomId){
    sendPlaybackEvent({
      action: 'player-activity',
      activity,
      fragId,
      fragIndex,
      uid: state.uid,
      playerName: state.me?.name || 'Player'
    });
  }
}

function checkRecordAbility(){
  const f = state.fragments[state.currentIndex];
  if(!f) {
    el('recordBtn').disabled = true;
    el('reviewBtn').disabled = true;
    return;
  }
  if (isPartyMode()) {
    const party = getPartyState();
    const activePartyIdx = party?.fragmentIndex ?? state.currentIndex;
    const isRecPhase = (!party || party.phase === 'recording') && state.currentIndex === activePartyIdx;
    el('recordBtn').disabled = !isRecPhase;
    el('recordBtn').title = isRecPhase
      ? "Record your take for this Party Showdown line"
      : (state.currentIndex !== activePartyIdx
        ? "Return to active Party line (turn off Edit Splits) to record"
        : "Recording is locked while voting or revealing winners");
  } else {
    const assigned = Array.isArray(f.assigned) ? f.assigned : [];
    const iAmAssigned = state.isSingleplayer || assigned.includes(state.uid);
    const canAssignMe = assigned.length < 2;
    const canRecord = iAmAssigned || canAssignMe;
    el('recordBtn').disabled = !canRecord;
    el('recordBtn').title = iAmAssigned
      ? "Record your take for this line"
      : canAssignMe
        ? "Record line (will assign you to this line)"
        : "Line already has 2 assigned players";
  }

  const anyTakes = Boolean(state.takes[f.id] && Object.keys(state.takes[f.id]).length > 0);
  el('reviewBtn').disabled = !anyTakes;

  if (!state.isPlaying || state.pb?.mode !== 'record') {
    if (el('recordBtn') && !el('recordBtn').classList.contains('is-armed')) {
      el('recordBtn').innerHTML = `Record Take <span class="key-hint">${escapeHtml(getHotkeyLabel('record'))}</span>`;
    }
  }
}

function selectFragment(idx, skipRedraw = false, isRemote = false){
  if (isPartyMode() && !isRemote && !(state.isHost && state.editMode)) {
    const partyIdx = getPartyState()?.fragmentIndex ?? state.currentIndex;
    if (idx !== partyIdx) {
      showNotice(
        state.isHost
          ? "Enable 'edit splits (Host)' to inspect or edit other lines."
          : "In Party Showdown, the host advances lines after each vote.",
        "info",
        2400
      );
      return;
    }
  }
  stopPlayback(isRemote);
  if(idx < 0 || idx >= state.fragments.length) return;
  state.currentIndex = idx;
  const f = state.fragments[idx];
  if(!f) return;
  
  el('fragLabel').textContent = idx + 1;
  el('fragTotal').textContent = state.fragments.length;
  
  const v = el('mainVideo');
  if(v && Number.isFinite(f.start)){
    if (!v.src || v.src === '' || v.src === window.location.href) {
      if (state.file) {
        if (state.videoURL) URL.revokeObjectURL(state.videoURL);
        state.videoURL = URL.createObjectURL(state.file);
        v.src = state.videoURL;
      } else if (state.roomId && !state.isSingleplayer) {
        v.src = `/api/rooms/${state.roomId}/video`;
      }
    }
    try {
      v.currentTime = f.start;
    } catch(e) {}
  }
  
  const dur = Math.max(0.05, f.end - f.start);
  if (el('laneCurrTime')) el('laneCurrTime').textContent = '0:00.0';
  if (el('laneTotalTime')) el('laneTotalTime').textContent = formatTimeSecTenths(dur);
  if (el('masterCurrTime')) el('masterCurrTime').textContent = formatTimecode(f.start);
  if (el('masterTotalTime')) el('masterTotalTime').textContent = formatTimecode(state.duration || 1);
  if (el('masterLineCount')) el('masterLineCount').textContent = `${state.fragments.length} Line${state.fragments.length !== 1 ? 's' : ''}`;
  updateMasterFragmentsDuration();

  renderAssignmentUI(f);
  checkRecordAbility();
  updateActiveLineTranscriptUI(f);
  updateActiveFragmentHighlight();
  
  if(!skipRedraw){
    renderFragmentList();
    renderMasterCanvas();
  }
  drawWave(f);
  updateLaneScoreDisplay(f);

  if(!state.isSingleplayer && state.roomId && !isRemote){
    broadcastMyActivity('idle', f.id, idx);
  }
}

if (el('prevFragBtn')) {
  el('prevFragBtn').onclick = () => {
    if (isPartyMode() && !(state.isHost && state.editMode)) {
      return showNotice("Party Showdown progresses one line at a time.", "info", 2000);
    }
    if(!state.fragments || state.fragments.length === 0){
      return showNotice("No dub lines available.", "info");
    }
    if(state.currentIndex <= 0){
      return showNotice("Already on the first line.", "info", 1800);
    }
    selectFragment(state.currentIndex - 1);
  };
}

if (el('nextFragBtn')) {
  el('nextFragBtn').onclick = () => {
    if (isPartyMode() && !(state.isHost && state.editMode)) {
      return showNotice("Party Showdown progresses when players ready up and host advances.", "info", 2000);
    }
    if(!state.fragments || state.fragments.length === 0){
      return showNotice("No dub lines available.", "info");
    }
    if(state.currentIndex >= state.fragments.length - 1){
      return showNotice("Already on the last line.", "info", 1800);
    }
    selectFragment(state.currentIndex + 1);
  };
}

function saveState() {
  state.undoStack.push({
    fragments: JSON.parse(JSON.stringify(state.fragments)),
    currentIndex: state.currentIndex
  });
  if (state.undoStack.length > 15) state.undoStack.shift();
  if (state.isHost) el('undoBtn').disabled = false;
}

if (el('undoBtn')) {
  el('undoBtn').onclick = async () => {
    if (!state.isHost) return showNotice("Only the room host can undo line edits.", "warning");
    if (state.undoStack.length === 0) return showNotice("Nothing to undo.", "info", 1800);
    try {
      const snap = state.undoStack.pop();
      if (state.undoStack.length === 0) el('undoBtn').disabled = true;

      if (isSoloSession()) {
        state.fragments = snap.fragments;
        state.currentIndex = Math.min(snap.currentIndex, state.fragments.length - 1);
        renderMasterCanvas();
        renderFragmentList();
        if (state.fragments.length > 0) selectFragment(state.currentIndex, true);
      } else {
        state.fragments = snap.fragments;
        state.currentIndex = Math.min(snap.currentIndex, state.fragments.length - 1);
        renderMasterCanvas();
        renderFragmentList();
        if (state.fragments.length > 0) selectFragment(state.currentIndex, true);
        sendPlaybackEvent({ action: 'sync-fragments', fragments: snap.fragments, activeLineIndex: state.currentIndex });
        const fb = await loadFirebase();
        if(fb && state.roomId){
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          await fb.updateDoc(roomRef, { fragments: snap.fragments, activeLineIndex: state.currentIndex });
        }
      }
      updateMasterFragmentsDuration();
      persistCurrentSession();
      showNotice("Reverted line edit.", "info", 1800);
    } catch(err) {
      console.error("Undo error:", err);
      showNotice("Failed to undo edit: " + (err?.message || "error"), "error");
    }
  };
}

async function mergeWithNext(index) {
  if (!state.isHost) return showNotice("Only the room host can merge lines.", "warning");
  if (index < 0 || index >= state.fragments.length - 1) return;
  try {
    saveState();
    
    const a = state.fragments[index];
    const b = state.fragments[index + 1];
    const assignedSet = new Set([...(a.assigned || []), ...(b.assigned || [])]);
    const newAssigned = Array.from(assignedSet).slice(0, 2);
    const mergedTranscript = [a.transcript, b.transcript].filter(t => typeof t === 'string' && t.trim()).join(' ');

    const merged = { 
      id: 'f_' + Math.random().toString(36).slice(2,8), 
      start: a.start, 
      end: b.end, 
      assigned: newAssigned,
      transcript: mergedTranscript
    };
    
    const newFrags = [...state.fragments];
    newFrags.splice(index, 2, merged);
    
    state.fragments = newFrags;
    state.currentIndex = Math.min(state.currentIndex, newFrags.length - 1);
    renderMasterCanvas();
    renderFragmentList();
    selectFragment(state.currentIndex, true);

    if (!isSoloSession() && state.roomId) {
      sendPlaybackEvent({ action: 'sync-fragments', fragments: newFrags, activeLineIndex: state.currentIndex });
      const fb = await loadFirebase();
      if(fb){
        const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
        await fb.updateDoc(roomRef, { fragments: newFrags, activeLineIndex: state.currentIndex });
      }
    }
    persistCurrentSession();
    showNotice(`Merged Line ${index + 1} with Line ${index + 2}.`, "info", 2000);
  } catch(err) {
    console.error("Merge error:", err);
    showNotice("Failed to merge lines: " + (err?.message || "error"), "error");
  }
}

// Edit Mode (Host only)
if (el('editToggleInput')) {
  el('editToggleInput').onchange = (e) => {
    if(!state.isHost) {
      e.target.checked = false;
      return showNotice("Only the host can enable line editing.", "warning");
    }
    state.editMode = e.target.checked;
    if (el('editToggle')) el('editToggle').classList.toggle('on', state.editMode);
    if (typeof syncPartyModeClasses === 'function') syncPartyModeClasses();
    if (isPartyMode()) {
      const party = getPartyState();
      if (!state.editMode && party && party.phase !== 'finale' && typeof party.fragmentIndex === 'number' && party.fragmentIndex !== state.currentIndex) {
        if (state.fragments[party.fragmentIndex]) {
          selectFragment(party.fragmentIndex, false, true);
        }
      }
      renderFragmentList();
      renderMasterCanvas();
      checkRecordAbility();
      if (typeof syncPartyUI === 'function') syncPartyUI();
      showNotice(
        state.editMode
          ? "Edit mode enabled — click any line in the list to inspect or edit splits & script."
          : "Edit mode disabled — returned to active Party line.",
        "info",
        2600
      );
      return;
    }
    showNotice(state.editMode ? "Line edit mode enabled. Click anywhere on the timeline to split lines." : "Line edit mode disabled.", "info", 2200);
  };
}

if (el('masterMultiTrackBtn')) {
  el('masterMultiTrackBtn').onclick = () => {
    state.masterMultiTrack = !state.masterMultiTrack;
    renderMasterCanvas();
  };
}

if (el('masterCanvas')) {
  el('masterCanvas').onclick = async (e) => {
    if(state.fragments.length === 0) return showNotice("No dub lines loaded.", "info");
    if (isPartyMode() && !(state.editMode && state.isHost)) {
      return showNotice("In Party Showdown, the host controls progression across lines.", "info", 2000);
    }
    const rect = el('masterCanvas').getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.duration;
    
    if(state.editMode && state.isHost){
      const idx = state.fragments.findIndex(f => t > f.start && t < f.end);
      if(idx > -1) {
        const f = state.fragments[idx];
        if(t - f.start < 0.3 || f.end - t < 0.3) {
          return showNotice("Slice too close to line boundary (minimum 0.3s).", "warning", 2400);
        }
        
        try {
          saveState();
          
          const a = { id: 'f_'+Math.random().toString(36).slice(2,6), start: f.start, end: t, assigned: [...(f.assigned || [])], transcript: f.transcript || '' };
          const b = { id: 'f_'+Math.random().toString(36).slice(2,6), start: t, end: f.end, assigned: [...(f.assigned || [])], transcript: '' };
          const newFrags = [...state.fragments];
          newFrags.splice(idx, 1, a, b);
          
          state.fragments = newFrags;
          renderMasterCanvas();
          renderFragmentList();
          selectFragment(idx, true, true);
          showNotice(`Split Line ${idx + 1} at ${t.toFixed(1)}s.`, "info", 2000);
          
          if (!isSoloSession() && state.roomId) {
            sendPlaybackEvent({ action: 'sync-fragments', fragments: newFrags, activeLineIndex: idx });
            const fb = await loadFirebase();
            if(fb){
              const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
              await fb.updateDoc(roomRef, { fragments: newFrags, activeLineIndex: idx });
            }
          }
          persistCurrentSession();
          if (state.masterBuffer) {
            autoTranscribeMissingFragments({ silent: true });
          }
        } catch(err) {
          console.error("Split line error:", err);
          showNotice("Could not split line: " + (err?.message || "error"), "error");
        }
      }
    } else {
      const idx = state.fragments.findIndex(f => t >= f.start && t <= f.end);
      if(idx > -1) {
        selectFragment(idx);
        const v = el('mainVideo');
        if (v) {
          try { v.currentTime = t; } catch(err) {}
        }
        const f = state.fragments[idx];
        const ratio = (t - f.start) / Math.max(0.05, f.end - f.start);
        drawWave(f, Math.max(0, Math.min(1, ratio)));
        renderMasterCanvas();
      }
    }
  };
}

// Click anywhere on line waveform to scrub and seek playback
if (el('waveCanvas')) {
  el('waveCanvas').onclick = (e) => {
    const f = state.fragments[state.currentIndex];
    if (!f || state.pb?.mode === 'record') return;
    const rect = el('waveCanvas').getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = Math.max(0.05, f.end - f.start);
    const targetTime = f.start + ratio * dur;
    const v = el('mainVideo');
    if (v) {
      try { v.currentTime = targetTime; } catch(err) {}
    }
    drawWave(f, ratio);
    renderMasterCanvas();
  };
}

function envelopeSlice(frag, pixelWidth){
  const out = new Float32Array(pixelWidth);
  if(!state.envelope) return out;
  const { env, rate } = state.envelope;
  const startIdx = Math.floor(frag.start * rate);
  const endIdx = Math.min(env.length, Math.ceil(frag.end * rate));
  const span = Math.max(1, endIdx - startIdx);
  
  let peak = 0;
  for(let x=0; x<pixelWidth; x++){
    const a = startIdx + Math.floor((x/pixelWidth) * span);
    const b = startIdx + Math.floor(((x+1)/pixelWidth) * span);
    let m = 0;
    for(let i=a; i<Math.max(a+1,b) && i<endIdx; i++) if(env[i] > m) m = env[i];
    out[x] = m;
    if(m > peak) peak = m;
  }
  if(peak > 0) for(let x=0; x<pixelWidth; x++) out[x] /= peak;
  return out;
}

function drawWave(frag, progress = 0){
  const canvas = el('waveCanvas');
  if(!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if(!rect.width || !rect.height) return;
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, mid = h/2;
  
  // 1. Dark studio background
  ctx.fillStyle = '#0D0A08';
  ctx.fillRect(0,0,w,h);

  const dur = Math.max(0.05, frag.end - frag.start);

  // 2. High-visibility timeline grid & seconds ruler
  const step = dur <= 2.5 ? 0.5 : dur <= 8 ? 1.0 : 2.0;
  ctx.font = '500 8.5px JetBrains Mono';
  ctx.fillStyle = 'rgba(243, 236, 225, 0.35)';
  ctx.lineWidth = 1;
  for(let t = 0; t <= dur; t += step){
    const gx = (t / dur) * w;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();

    ctx.strokeStyle = 'rgba(243, 236, 225, 0.25)';
    ctx.beginPath();
    ctx.moveTo(gx, 0); ctx.lineTo(gx, 4); ctx.stroke();
    if(gx > 14 && gx < w - 24){
      ctx.fillText(`${t.toFixed(1)}s`, gx + 3, 11);
    }
  }

  // 3. Center dashed baseline
  ctx.beginPath();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  ctx.setLineDash([]);

  // 4. Original Audio Waveform (Warm Golden Acoustic Envelope)
  const targetEnv = envelopeSlice(frag, Math.round(w));
  // Underfill
  ctx.beginPath();
  for(let x=0; x<w; x++){
    const amp = (targetEnv[x] || 0) * (h * 0.44);
    if(x === 0) ctx.moveTo(x, mid - amp);
    else ctx.lineTo(x, mid - amp);
  }
  for(let x=w-1; x>=0; x--){
    const amp = (targetEnv[x] || 0) * (h * 0.44);
    ctx.lineTo(x, mid + amp);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(224, 172, 106, 0.16)';
  ctx.fill();

  // Vibrant Stroke
  ctx.beginPath();
  ctx.strokeStyle = '#E0AC6A';
  ctx.lineWidth = 1.6;
  ctx.shadowColor = 'rgba(224, 172, 106, 0.4)';
  ctx.shadowBlur = 4;
  for(let x=0; x<w; x++){
    const amp = (targetEnv[x] || 0) * (h * 0.44);
    ctx.moveTo(x, mid - amp);
    ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 5. Draw Takes (Live & Saved Takes)
  if(state.pb && state.pb.mode === 'record'){
    // Live trace
    ctx.beginPath();
    ctx.strokeStyle = '#FF453A';
    ctx.lineWidth = 2.0;
    ctx.shadowColor = 'rgba(255, 69, 58, 0.55)';
    ctx.shadowBlur = 6;
    for(let x=0; x<state.liveTrace.length; x++){
      const amp = (state.liveTrace[x] || 0) * (h * 0.44);
      ctx.moveTo(x, mid - amp);
      ctx.lineTo(x, mid + amp);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    // Saved takes
    const takes = state.takes[frag.id] || {};
    const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    let targetUids;
    if (isPartyMode()) {
      const party = getPartyState();
      const spotUid = party?.spotlightUid || party?.winners?.[frag.id]?.uid;
      targetUids = Object.keys(takes).sort((a, b) => {
        if (a === spotUid) return 1;
        if (b === spotUid) return -1;
        if (a === state.uid) return 1;
        if (b === state.uid) return -1;
        return 0;
      });
    } else {
      targetUids = Array.isArray(frag.assigned) ? frag.assigned : [];
    }
    targetUids.forEach(uid => {
      if(takes[uid] && takes[uid].trace){
        const pColor = roomPlayers.find(p => p.id === uid)?.color || '#B285F5';
        ctx.beginPath();
        ctx.strokeStyle = pColor;
        ctx.lineWidth = 1.8;
        ctx.shadowColor = pColor;
        ctx.shadowBlur = 4;
        for(let x=0; x<takes[uid].trace.length; x++){
          const amp = (takes[uid].trace[x] || 0) * (h * 0.44);
          ctx.moveTo(x, mid - amp);
          ctx.lineTo(x, mid + amp);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    });
  }

  // 6. Playhead with Glow, Needle, and Top Cap
  if(progress > 0){
    const px = Math.max(0, Math.min(w, progress * w));
    // Soft bloom
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(178, 133, 245, 0.45)';
    ctx.lineWidth = 6;
    ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();

    // Sharp white needle
    ctx.beginPath();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();

    // Top Triangle Head
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }

  // 7. Update Line Readout Header
  const curLineTime = Math.max(0, progress * dur);
  if (el('laneCurrTime')) el('laneCurrTime').textContent = formatTimeSecTenths(curLineTime);
  if (el('laneTotalTime')) el('laneTotalTime').textContent = formatTimeSecTenths(dur);
}

function getScoreTier(score) {
  if (score >= 88) return { tier: 's', label: 'Perfect Match', toastType: 'success' };
  if (score >= 72) return { tier: 'a', label: 'Great Match', toastType: 'success' };
  if (score >= 50) return { tier: 'b', label: 'Good Match', toastType: 'info' };
  return { tier: 'c', label: 'Needs Practice', toastType: 'warning' };
}

function getBufferEnvelope(buffer, bins = 100) {
  if (!buffer) return null;
  const data = buffer.getChannelData(0);
  const total = data.length;
  if (total === 0) return null;
  const binSize = Math.max(1, Math.floor(total / bins));
  const env = new Float32Array(bins);
  let peak = 0;
  for (let b = 0; b < bins; b++) {
    const start = b * binSize;
    const end = Math.min(start + binSize, total);
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += data[i] * data[i];
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    env[b] = rms;
    if (rms > peak) peak = rms;
  }
  return { env, peak };
}

function computeWaveMatchScore(frag, recordedBuffer, recordedTrace) {
  if (!frag) return 0;
  const BINS = 100;

  // 1. Target envelope from original video audio for this line
  const origEnv = envelopeSlice(frag, BINS);
  let origPeak = 0;
  for (let i = 0; i < BINS; i++) {
    if (origEnv[i] > origPeak) origPeak = origEnv[i];
  }

  // 2. User recorded envelope
  let userEnv = null;
  let userPeak = 0;

  const bufResult = getBufferEnvelope(recordedBuffer, BINS);
  if (bufResult && bufResult.peak > 0) {
    userEnv = bufResult.env;
    userPeak = bufResult.peak;
  } else if (recordedTrace && recordedTrace.length > 0) {
    userEnv = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      const idx = Math.min(recordedTrace.length - 1, Math.floor((b / BINS) * recordedTrace.length));
      const val = recordedTrace[idx] || 0;
      userEnv[b] = val;
      if (val > userPeak) userPeak = val;
    }
  }

  // Silent or negligible recording
  if (!userEnv || userPeak < 0.012) {
    return 0;
  }

  // Normalize user envelope to 0..1
  const normUser = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    normUser[i] = Math.min(1, userEnv[i] / (userPeak || 1));
  }

  // 3. Statistical correlation (Pearson r) between original speech dynamics and take
  let sumO = 0, sumU = 0;
  for (let i = 0; i < BINS; i++) {
    sumO += origEnv[i];
    sumU += normUser[i];
  }
  const meanO = sumO / BINS;
  const meanU = sumU / BINS;

  let num = 0, denO = 0, denU = 0;
  let matchCount = 0;
  let absDiffSum = 0;

  for (let i = 0; i < BINS; i++) {
    const do_ = origEnv[i] - meanO;
    const du_ = normUser[i] - meanU;
    num += do_ * du_;
    denO += do_ * do_;
    denU += du_ * du_;

    // Voice activity detection threshold: is speech active in this bin?
    const actO = origEnv[i] > 0.18;
    const actU = normUser[i] > 0.18;
    if (actO === actU) matchCount++;

    absDiffSum += Math.abs(origEnv[i] - normUser[i]);
  }

  const den = Math.sqrt(denO * denU);
  const r = den > 0.0001 ? num / den : 0;

  // Correlation component (0-100)
  const rScore = Math.max(0, Math.min(100, Math.round(((r + 0.15) / 1.15) * 100)));

  // Timing alignment component (0-100)
  const timingScore = Math.round((matchCount / BINS) * 100);

  // Waveform shape distance component (0-100)
  const diffScore = Math.max(0, Math.min(100, Math.round((1 - (absDiffSum / BINS)) * 100)));

  // Composite weighted score
  const finalScore = Math.max(
    0,
    Math.min(100, Math.round(0.45 * rScore + 0.35 * timingScore + 0.20 * diffScore))
  );

  return finalScore;
}

function updateLaneScoreDisplay(frag) {
  const badge = el('laneScoreBadge');
  if (!badge) return;
  if (!state.scoringMode || !frag) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = 'inline-flex';
  const takes = state.takes[frag.id] || {};
  let targetTake = takes[state.uid];
  if (!targetTake) {
    const all = Object.values(takes);
    if (all.length > 0) {
      targetTake = all.reduce((best, t) => (t.score || 0) > (best.score || 0) ? t : best, all[0]);
    }
  }

  if (targetTake && typeof targetTake.score === 'number' && targetTake.score > 0) {
    const info = getScoreTier(targetTake.score);
    badge.className = `lane-score-badge tier-${info.tier}`;
    badge.innerHTML = `★ <strong>${targetTake.score}%</strong> <span>${info.label}</span>`;
  } else {
    badge.className = 'lane-score-badge';
    badge.innerHTML = `<span style="opacity:0.75;">Waveform Scoring:</span> <span style="font-weight:400; opacity:0.9;">Record take to score</span>`;
  }
}

const MASTER_RULER_H = 18;
const MASTER_ORIG_H = 26;
const MASTER_LANE_H = 34;
let lastMasterTrackHeaderSig = '';

function hexToRgba(hex, alpha = 1) {
  if (typeof hex !== 'string') return `rgba(178, 133, 245, ${alpha})`;
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  if (full.length !== 6) return `rgba(178, 133, 245, ${alpha})`;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(178, 133, 245, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getTakeWaveformEnvelope(take, bins = 48) {
  if (!take) return null;
  if (Array.isArray(take._masterEnv) && take._masterEnv.length > 0) {
    return take._masterEnv;
  }
  const buf = take.buffer;
  if (buf && typeof buf.getChannelData === 'function' && buf.length > 0) {
    const data = buf.getChannelData(0);
    const len = data.length;
    const count = Math.max(8, Math.min(bins, len));
    const step = Math.max(1, Math.floor(len / count));
    const out = new Array(count).fill(0);
    let maxPeak = 0.0001;
    for (let i = 0; i < count; i++) {
      const start = i * step;
      const end = Math.min(len, start + step);
      const stride = Math.max(1, Math.floor((end - start) / 24));
      let peak = 0;
      for (let j = start; j < end; j += stride) {
        const a = Math.abs(data[j]);
        if (a > peak) peak = a;
      }
      out[i] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }
    const normFactor = maxPeak > 0.02 ? (1 / maxPeak) : 1;
    for (let i = 0; i < count; i++) {
      out[i] = Math.min(1, out[i] * normFactor);
    }
    take._masterEnv = out;
    return out;
  }
  if (Array.isArray(take.trace) && take.trace.length > 0) {
    take._masterEnv = take.trace;
    return take.trace;
  }
  return null;
}

function getMasterTracks() {
  const basePlayers = Array.isArray(state.roomData?.players) && state.roomData.players.length > 0
    ? state.roomData.players
    : (state.me ? [state.me] : [{ id: state.uid || 'local', name: 'You', color: PLAYER_COLORS[0] }]);

  const tracks = [];
  const byId = new Map();
  basePlayers.forEach((p, idx) => {
    if (!p || !p.id || byId.has(p.id)) return;
    const entry = {
      id: p.id,
      name: p.name || getAnonymousPlayerName(idx),
      color: p.color || PLAYER_COLORS[idx % PLAYER_COLORS.length],
      isSelf: p.id === state.uid
    };
    byId.set(p.id, entry);
    tracks.push(entry);
  });

  // Ensure any extra player IDs with assignments or takes remain visible on the multi-track timeline
  state.fragments.forEach((f) => {
    (f.assigned || []).forEach((uid) => {
      if (uid && !byId.has(uid)) {
        const idx = tracks.length;
        const entry = {
          id: uid,
          name: uid === state.uid ? (state.me?.name || 'You') : getAnonymousPlayerName(idx),
          color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
          isSelf: uid === state.uid
        };
        byId.set(uid, entry);
        tracks.push(entry);
      }
    });
    const fTakes = state.takes[f.id] || {};
    Object.keys(fTakes).forEach((uid) => {
      if (uid && !byId.has(uid)) {
        const idx = tracks.length;
        const entry = {
          id: uid,
          name: uid === state.uid ? (state.me?.name || 'You') : getAnonymousPlayerName(idx),
          color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
          isSelf: uid === state.uid
        };
        byId.set(uid, entry);
        tracks.push(entry);
      }
    });
  });

  const localIsRecording = Boolean(state.isPlaying && !state.paused && state.pb?.mode === 'record');
  return tracks.map((t) => {
    let assignedCount = 0;
    let takeCount = 0;
    state.fragments.forEach((f) => {
      const hasTake = Boolean(state.takes[f.id] && state.takes[f.id][t.id]);
      const isAssigned = Array.isArray(f.assigned) && f.assigned.includes(t.id);
      if (isAssigned) assignedCount++;
      if (hasTake) takeCount++;
    });
    const act = state.playerActivities?.[t.id];
    const isRecording = Boolean(
      (localIsRecording && t.isSelf) ||
      (act && act.activity === 'recording' && (!act.updatedAt || (Date.now() - act.updatedAt) < 120000))
    );
    const recordingFragIdx = localIsRecording && t.isSelf
      ? state.currentIndex
      : (typeof act?.fragIndex === 'number' ? act.fragIndex : -1);

    return {
      ...t,
      assignedCount,
      takeCount,
      isRecording,
      recordingFragIdx
    };
  });
}

function renderMasterTrackHeaders(tracks) {
  const container = el('masterTrackHeaders');
  if (!container) return;
  const sig = tracks.map(t => `${t.id}:${t.name}:${t.color}:${t.isSelf ? 1 : 0}:${t.takeCount}/${t.assignedCount}:${t.isRecording ? 1 : 0}`).join('|');
  if (sig === lastMasterTrackHeaderSig) return;
  lastMasterTrackHeaderSig = sig;

  let html = '<div class="master-track-ruler-spacer">Tracks</div>';
  html += `
    <div class="master-track-header is-ref" title="Original reference clip audio">
      <span class="master-track-dot" style="background:#E8A33D; box-shadow:0 0 6px rgba(232,163,61,0.5);"></span>
      <span class="master-track-name">Original Ref</span>
    </div>
  `;

  tracks.forEach((t) => {
    const countLabel = t.assignedCount > 0 ? `${t.takeCount}/${t.assignedCount}` : `${t.takeCount}`;
    const displayName = t.isSelf ? `${t.name} (You)` : t.name;
    html += `
      <div class="master-track-header is-character ${t.isSelf ? 'is-self' : ''}" data-track-uid="${escapeHtml(t.id)}" title="Click to jump to ${escapeHtml(t.name)}'s next line">
        <span class="master-track-dot" style="background:${escapeHtml(t.color)}; box-shadow:0 0 6px ${hexToRgba(t.color, 0.6)};"></span>
        <span class="master-track-name">${escapeHtml(displayName)}</span>
        ${t.isRecording ? '<span class="master-track-rec-pip" title="Recording now"></span>' : ''}
        <span class="master-track-count">${countLabel}</span>
      </div>
    `;
  });

  container.innerHTML = html;
  container.querySelectorAll('.master-track-header.is-character').forEach((row) => {
    row.onclick = () => {
      const uid = row.getAttribute('data-track-uid');
      if (!uid || !state.fragments.length) return;
      const nextUnrecorded = state.fragments.findIndex(
        (f, idx) => idx > state.currentIndex && (f.assigned || []).includes(uid) && !(state.takes[f.id] && state.takes[f.id][uid])
      );
      const firstUnrecorded = state.fragments.findIndex(
        f => (f.assigned || []).includes(uid) && !(state.takes[f.id] && state.takes[f.id][uid])
      );
      const nextAssigned = state.fragments.findIndex(
        (f, idx) => idx > state.currentIndex && ((f.assigned || []).includes(uid) || (state.takes[f.id] && state.takes[f.id][uid]))
      );
      const firstAssigned = state.fragments.findIndex(
        f => (f.assigned || []).includes(uid) || (state.takes[f.id] && state.takes[f.id][uid])
      );
      const targetIdx = [nextUnrecorded, firstUnrecorded, nextAssigned, firstAssigned].find(i => i > -1);
      if (typeof targetIdx === 'number' && targetIdx > -1) {
        selectFragment(targetIdx);
      } else {
        showNotice("No lines assigned to this character yet.", "info", 1800);
      }
    };
  });
}

function renderMasterCanvas(){
  const canvas = el('masterCanvas');
  if(!canvas) return;

  const isMultiTrack = Boolean(state.masterMultiTrack);
  const masterPanel = canvas.closest('.master-panel');
  if (masterPanel) masterPanel.classList.toggle('is-multitrack', isMultiTrack);
  const mtBtn = el('masterMultiTrackBtn');
  if (mtBtn) {
    mtBtn.classList.toggle('is-active', isMultiTrack);
    mtBtn.setAttribute('aria-pressed', isMultiTrack ? 'true' : 'false');
  }
  const mtBtnText = el('masterMultiTrackBtnText');
  if (mtBtnText) mtBtnText.textContent = isMultiTrack ? 'Compact View' : 'Multi-Track';

  const trackHeadersEl = el('masterTrackHeaders');
  const tracks = isMultiTrack ? getMasterTracks() : [];

  if (isMultiTrack) {
    const totalH = MASTER_RULER_H + MASTER_ORIG_H + Math.max(1, tracks.length) * MASTER_LANE_H;
    canvas.style.height = `${totalH}px`;
    if (trackHeadersEl) {
      trackHeadersEl.style.display = 'flex';
      renderMasterTrackHeaders(tracks);
    }
  } else {
    canvas.style.height = '';
    if (trackHeadersEl) trackHeadersEl.style.display = 'none';
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if(!rect.width || !rect.height) return;
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  
  // 1. Studio Dark Timeline Background
  ctx.fillStyle = '#0D0A08';
  ctx.fillRect(0, 0, w, h);
  
  const dur = Math.max(0.1, state.duration || 1);
  const v = el('mainVideo');
  const currTime = v ? (v.currentTime || 0) : 0;

  if (isMultiTrack) {
    // --- MULTI-TRACK ALIGNMENT VIEW ---
    const rulerH = MASTER_RULER_H;
    const origH = MASTER_ORIG_H;
    const laneH = MASTER_LANE_H;

    // Highlight active fragment column across all lanes
    const curFrag = state.fragments[state.currentIndex];
    if (curFrag) {
      const cx0 = Math.max(0, (curFrag.start / dur) * w);
      const cx1 = Math.min(w, (curFrag.end / dur) * w);
      ctx.fillStyle = 'rgba(232, 163, 61, 0.08)';
      ctx.fillRect(cx0, rulerH, Math.max(2, cx1 - cx0), h - rulerH);
    }

    // Time Ruler header strip + ticks + subtle vertical gridlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, w, rulerH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerH);
    ctx.lineTo(w, rulerH);
    ctx.stroke();

    const tickStep = dur > 60 ? 10 : dur > 20 ? 5 : 2;
    ctx.font = '500 8.5px JetBrains Mono';
    for (let t = 0; t <= dur; t += tickStep) {
      const tx = (t / dur) * w;
      ctx.strokeStyle = 'rgba(243, 236, 225, 0.18)';
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, 6);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.beginPath();
      ctx.moveTo(tx, rulerH);
      ctx.lineTo(tx, h);
      ctx.stroke();
      if (tx > 12 && tx < w - 22) {
        const label = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        ctx.fillStyle = 'rgba(243, 236, 225, 0.42)';
        ctx.fillText(label, tx - 10, 13);
      }
    }

    // Row 0: Original Reference Speech Envelope + Line Boundaries
    const origY = rulerH;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(0, origY, w, origH);
    if (state.envelope && state.envelope.env && state.envelope.env.length > 0) {
      const env = state.envelope.env;
      const envLen = env.length;
      const midY = origY + origH / 2;
      ctx.fillStyle = 'rgba(232, 163, 61, 0.45)';
      for (let x = 0; x < w; x++) {
        const envIdx = Math.min(envLen - 1, Math.floor((x / w) * envLen));
        const amp = (env[envIdx] || 0) * (origH * 0.40);
        ctx.fillRect(x, midY - amp, 1, Math.max(1, amp * 2));
      }
    }
    state.fragments.forEach((f, i) => {
      const x0 = Math.max(0, (f.start / dur) * w);
      const x1 = Math.min(w, (f.end / dur) * w);
      const bw = Math.max(2, x1 - x0);
      const isCur = i === state.currentIndex;
      ctx.strokeStyle = isCur ? 'rgba(232, 163, 61, 0.85)' : 'rgba(243, 236, 225, 0.14)';
      ctx.lineWidth = isCur ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, origY);
      ctx.lineTo(x0, origY + origH);
      ctx.stroke();
      if (bw > 20) {
        ctx.fillStyle = isCur ? '#F7C97E' : 'rgba(243, 236, 225, 0.52)';
        ctx.font = isCur ? '700 8.5px JetBrains Mono' : '500 8px JetBrains Mono';
        ctx.fillText(`L${i + 1}`, x0 + 4, origY + 10);
      }
    });
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, origY + origH);
    ctx.lineTo(w, origY + origH);
    ctx.stroke();

    // Rows 1..N: Parallel Character / Player Lanes
    const latencySec = (Number(settings.get('micLatencyMs')) || 0) / 1000;
    tracks.forEach((track, tIdx) => {
      const laneY = rulerH + origH + tIdx * laneH;
      if (tIdx % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.014)';
        ctx.fillRect(0, laneY, w, laneH);
      }

      // Draw subtle vertical fragment guide lines inside lane
      state.fragments.forEach((f, fIdx) => {
        const x0 = Math.max(0, (f.start / dur) * w);
        const x1 = Math.min(w, (f.end / dur) * w);
        const slotW = Math.max(2, x1 - x0);
        const isCur = fIdx === state.currentIndex;
        const isAssigned = Array.isArray(f.assigned) && f.assigned.includes(track.id);
        const take = state.takes[f.id]?.[track.id];

        // Assigned slot indicator (dashed outline when waiting for take)
        if (isAssigned && !take) {
          ctx.save();
          ctx.fillStyle = hexToRgba(track.color, isCur ? 0.14 : 0.07);
          ctx.fillRect(x0 + 1, laneY + 5, Math.max(1, slotW - 2), laneH - 10);
          ctx.strokeStyle = hexToRgba(track.color, isCur ? 0.85 : 0.42);
          ctx.lineWidth = isCur ? 1.4 : 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(x0 + 1, laneY + 5, Math.max(1, slotW - 2), laneH - 10);
          ctx.restore();
        }

        // Recorded take clip block aligned by mic latency & true recorded duration
        if (take) {
          const takeStart = Math.max(0, (Number(f.start) || 0) + latencySec);
          const takeDur = take.buffer?.duration ? Math.max(0.08, take.buffer.duration) : Math.max(0.08, f.end - f.start);
          const takeEnd = Math.min(dur, takeStart + takeDur);
          const tx0 = Math.max(0, (takeStart / dur) * w);
          const tx1 = Math.min(w, (takeEnd / dur) * w);
          const clipW = Math.max(4, tx1 - tx0);
          const clipY = laneY + 4;
          const clipH = laneH - 8;

          ctx.fillStyle = hexToRgba(track.color, isCur ? 0.34 : 0.23);
          ctx.fillRect(tx0, clipY, clipW, clipH);

          // Waveform inside recorded clip
          const takeEnv = getTakeWaveformEnvelope(take, 48);
          if (takeEnv && takeEnv.length > 0 && clipW >= 6) {
            const clipMidY = clipY + clipH / 2;
            const barCount = Math.max(2, Math.floor(clipW));
            ctx.fillStyle = hexToRgba(track.color, 0.92);
            for (let bx = 0; bx < barCount; bx++) {
              const eIdx = Math.min(takeEnv.length - 1, Math.floor((bx / barCount) * takeEnv.length));
              const amp = Math.max(0.06, takeEnv[eIdx] || 0) * (clipH * 0.42);
              ctx.fillRect(tx0 + bx, clipMidY - amp, 1, Math.max(1.5, amp * 2));
            }
          }

          // Clip border
          ctx.strokeStyle = isCur ? '#FFFFFF' : track.color;
          ctx.lineWidth = isCur ? 1.6 : 1.2;
          ctx.strokeRect(tx0, clipY, clipW, clipH);

          // Tiny line / score badge inside clip if wide enough
          if (clipW > 22) {
            const label = (state.scoringMode && typeof take.score === 'number')
              ? `L${fIdx + 1}·${Math.round(take.score)}%`
              : `L${fIdx + 1}`;
            ctx.font = '600 8px JetBrains Mono';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(label, tx0 + 3, clipY + 9);
          }
        }

        // Live active recording highlight on this track's target fragment
        if (track.isRecording && track.recordingFragIdx === fIdx) {
          ctx.fillStyle = 'rgba(255, 69, 58, 0.25)';
          ctx.fillRect(x0 + 1, laneY + 3, Math.max(2, slotW - 2), laneH - 6);
          ctx.strokeStyle = '#FF453A';
          ctx.lineWidth = 1.6;
          ctx.strokeRect(x0 + 1, laneY + 3, Math.max(2, slotW - 2), laneH - 6);
        }
      });

      // Track bottom divider
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, laneY + laneH);
      ctx.lineTo(w, laneY + laneH);
      ctx.stroke();
    });
  } else {
    // --- COMPACT SINGLE-LANE MASTER VIEW ---
    // 2. Audio Envelope Background Overview across full video
    if(state.envelope && state.envelope.env && state.envelope.env.length > 0){
      const env = state.envelope.env;
      const envLen = env.length;
      const midH = h / 2 + 5;
      ctx.fillStyle = 'rgba(178, 133, 245, 0.15)';
      for(let x=0; x<w; x++){
        const envIdx = Math.min(envLen - 1, Math.floor((x / w) * envLen));
        const amp = (env[envIdx] || 0) * (h * 0.36);
        ctx.fillRect(x, midH - amp, 1, Math.max(1, amp * 2));
      }
    }
    
    // 3. Time Ruler Ticks along the top of master timeline
    const tickStep = dur > 60 ? 10 : dur > 20 ? 5 : 2;
    ctx.font = '500 8.5px JetBrains Mono';
    ctx.fillStyle = 'rgba(243, 236, 225, 0.3)';
    ctx.strokeStyle = 'rgba(243, 236, 225, 0.15)';
    ctx.lineWidth = 1;
    for(let t = 0; t <= dur; t += tickStep){
      const tx = (t / dur) * w;
      ctx.beginPath();
      ctx.moveTo(tx, 0); ctx.lineTo(tx, 5); ctx.stroke();
      if(tx > 14 && tx < w - 20){
        const label = `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
        ctx.fillText(label, tx - 10, 11);
      }
    }
    
    // 4. Line/Fragment Blocks with High-Contrast Status
    state.fragments.forEach((f, i) => {
      const x0 = Math.max(0, (f.start / dur) * w);
      const x1 = Math.min(w, (f.end / dur) * w);
      const blockW = Math.max(2, x1 - x0);
      const isCur = i === state.currentIndex;
      const partyWinners = isPartyMode() ? (getPartyState()?.winners || {}) : null;
      const isDone = isPartyMode()
        ? Boolean(partyWinners?.[f.id])
        : (Array.isArray(f.assigned) && f.assigned.length > 0 && f.assigned.every(id => state.takes[f.id] && state.takes[f.id][id]));
      
      // Fill
      if(isCur){
        ctx.fillStyle = 'rgba(232, 163, 61, 0.32)';
      } else if(isDone){
        ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      } else {
        ctx.fillStyle = 'rgba(178, 133, 245, 0.10)';
      }
      ctx.fillRect(x0 + 1, 14, Math.max(1, blockW - 2), h - 16);
      
      // Border
      if(isCur){
        ctx.strokeStyle = '#E8A33D';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(232, 163, 61, 0.6)';
        ctx.shadowBlur = 6;
      } else if(isDone){
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = 'rgba(178, 133, 245, 0.35)';
        ctx.lineWidth = 1;
        ctx.shadowBlur = 0;
      }
      ctx.strokeRect(x0 + 1, 14, Math.max(1, blockW - 2), h - 16);
      ctx.shadowBlur = 0;
      
      // Line Number Badge inside block if wide enough
      if(blockW > 18){
        ctx.fillStyle = isCur ? '#FFFFFF' : isDone ? '#79F2B8' : 'rgba(243, 236, 225, 0.7)';
        ctx.font = isCur ? '700 9.5px JetBrains Mono' : '600 9px JetBrains Mono';
        ctx.fillText(`L${i+1}`, x0 + 4, h - 5);
      }
    });
  }
  
  // 5. Real-Time Master Playhead Needle
  if(dur > 0 && currTime >= 0){
    const playX = Math.max(0, Math.min(w, (currTime / dur) * w));
    // Playhead line
    ctx.beginPath();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(178, 133, 245, 0.8)';
    ctx.shadowBlur = 6;
    ctx.moveTo(playX, 0); ctx.lineTo(playX, h); ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Top Playhead Diamond Marker
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX + 4, 5);
    ctx.lineTo(playX, 10);
    ctx.lineTo(playX - 4, 5);
    ctx.closePath();
    ctx.fill();
  }
  
  // 6. Sync Master Header Info
  if(el('masterCurrTime')) el('masterCurrTime').textContent = formatTimecode(currTime);
  if(el('masterTotalTime')) el('masterTotalTime').textContent = formatTimecode(dur);
  if(el('masterLineCount')) el('masterLineCount').textContent = `${state.fragments.length} Line${state.fragments.length !== 1 ? 's' : ''}`;
  updateMasterFragmentsDuration();
}

function renderFragmentList(){
  const list = el('fragmentList');
  updateMasterFragmentsDuration();
  if(!list) return;
  list.innerHTML = '';
  const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
  const isPlaying = Boolean(state.isPlaying && !state.paused);
  const isRec = Boolean(isPlaying && state.pb?.mode === 'record');
  const isPlay = Boolean(isPlaying && state.pb?.mode !== 'record');

  const isParty = isPartyMode();
  const party = isParty ? getPartyState() : null;
  const activePartyIdx = party?.fragmentIndex ?? state.currentIndex;
  const isHostEdit = Boolean(state.isHost && state.editMode);

  state.fragments.forEach((f, i) => {
    const isCurrent = (i === state.currentIndex);
    let rowClasses = 'frag-row';
    let activeTagHTML = '';
    if (isParty && i !== activePartyIdx && !isHostEdit) {
      rowClasses += ' is-party-locked';
    }
    if (isCurrent) {
      rowClasses += ' active';
      if (isRec) {
        rowClasses += ' is-recording';
        activeTagHTML = '<span class="frag-active-indicator rec-tag"><span class="dot"></span>REC</span>';
      } else if (isPlay) {
        rowClasses += ' is-playing';
        activeTagHTML = '<span class="frag-active-indicator play-tag">PLAYING</span>';
      }
    }

    const row = document.createElement('div');
    row.className = rowClasses;

    const takesForFrag = state.takes[f.id] || {};
    const availableTakeUids = Object.keys(takesForFrag).filter((uid) => {
      const t = takesForFrag[uid];
      return Boolean(t && (t.buffer || (Array.isArray(t.trace) && t.trace.length > 0)));
    });
    const compareCount = availableTakeUids.length;

    let assignHTML = '';
    const assignedList = Array.isArray(f.assigned) ? f.assigned : [];
    if (isParty) {
      const winner = party?.winners?.[f.id];
      if (winner) {
        const wColor = winner.playerColor || '#B285F5';
        const wName = winner.playerName || 'Winner';
        assignHTML += `<span class="assignee-chip done" title="Winning dub for Line ${i + 1}" style="--chip-color:${escapeHtml(wColor)}"><span class="assignee-dot"></span>★ ${escapeHtml(wName)}</span>`;
      }
      if (compareCount > 0) {
        assignHTML += `<span style="font-size:10px; color:var(--text-dim);">${compareCount} take${compareCount === 1 ? '' : 's'}</span>`;
      } else if (!winner) {
        assignHTML = '<span style="font-size:10px; color:var(--text-faint);">Everyone dubs</span>';
      }
    } else if(assignedList.length === 0){
      assignHTML = '<span style="font-size:10px; color:var(--text-faint);">Unassigned</span>';
    } else {
      assignedList.forEach(uid => {
        const p = roomPlayers.find(x => x.id === uid);
        const take = state.takes[f.id] && state.takes[f.id][uid];
        const hasTake = Boolean(take);
        const pName = p ? p.name : (uid === state.uid ? (state.me?.name || 'You') : 'Player');
        const pColor = p ? p.color : '#B285F5';
        let scorePill = '';
        if (state.scoringMode && take && typeof take.score === 'number' && take.score > 0) {
          const tier = getScoreTier(take.score).tier;
          scorePill = `<span class="score-pill tier-${tier}">★ ${take.score}%</span>`;
        }
        assignHTML += `<span class="assignee-chip ${hasTake?'done':''}" title="${pName}${hasTake ? ' - take recorded' : ' - assigned'}" style="--chip-color:${pColor}"><span class="assignee-dot"></span>${pName}${scorePill}</span>`;
      });
    }

    let liveRecHTML = '';
    const activeRecorder = Object.entries(state.playerActivities).find(
      ([uid, act]) => act.activity === 'recording' && (act.fragId === f.id || act.fragIndex === i)
    );
    if(activeRecorder){
      const recPlayer = roomPlayers.find(x => x.id === activeRecorder[0]);
      const recName = recPlayer ? recPlayer.name : activeRecorder[1].playerName || 'Player';
      liveRecHTML = `<div class="frag-live-recording"><span class="dot"></span>${recName} recording</div>`;
    }

    const compareBtnHTML = compareCount > 0
      ? `<button type="button" class="frag-compare-btn" data-compare-frag="${i}" title="Compare waveform peaks side-by-side for Line ${i + 1}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="4" y2="12"></line><line x1="8" y1="7" x2="8" y2="17"></line><line x1="12" y1="4" x2="12" y2="20"></line><line x1="16" y1="8" x2="16" y2="16"></line><line x1="20" y1="11" x2="20" y2="13"></line></svg>
          <span>Compare${compareCount > 1 ? ` (${compareCount})` : ''}</span>
        </button>`
      : '';

    row.innerHTML = `
      <span class="frag-num">${String(i+1).padStart(2,'0')}</span>
      <div class="frag-info">
        <div class="frag-top-line">
          <div style="display:inline-flex; align-items:center; min-width:0;">
            <span class="frag-time">${f.start.toFixed(1)}s - ${f.end.toFixed(1)}s</span>
            ${activeTagHTML}
          </div>
          ${compareBtnHTML}
        </div>
        <div class="frag-assignees" style="margin-top:4px;">${assignHTML}</div>
        ${liveRecHTML}
      </div>
    `;

    const cmpBtn = row.querySelector('[data-compare-frag]');
    if (cmpBtn) {
      cmpBtn.onclick = (ev) => {
        ev.stopPropagation();
        openCompareTakesModal(i);
      };
    }

    row.onclick = () => selectFragment(i);
    list.appendChild(row);

    if (state.isHost && (!isParty || isHostEdit) && i < state.fragments.length - 1) {
      const mergeRow = document.createElement('div');
      mergeRow.className = 'merge-row';
      const btn = document.createElement('button');
      btn.className = 'merge-btn';
      btn.textContent = 'Merge with next';
      btn.onclick = (ev) => { ev.stopPropagation(); mergeWithNext(i); };
      mergeRow.appendChild(btn);
      list.appendChild(mergeRow);
    }
  });
}

function updateActiveFragmentHighlight() {
  const rows = document.querySelectorAll('.frag-row');
  const isPlaying = Boolean(state.isPlaying && !state.paused);
  const isRec = Boolean(isPlaying && state.pb?.mode === 'record');
  const isPlay = Boolean(isPlaying && state.pb?.mode !== 'record');

  rows.forEach((row, i) => {
    const isCurrent = (i === state.currentIndex);
    row.classList.toggle('active', isCurrent);
    row.classList.toggle('is-recording', isCurrent && isRec);
    row.classList.toggle('is-playing', isCurrent && isPlay);

    let tag = row.querySelector('.frag-active-indicator');
    if (isCurrent && isRec) {
      if (!tag) {
        tag = document.createElement('span');
        const timeWrap = row.querySelector('.frag-top-line > div:first-child');
        if (timeWrap) timeWrap.appendChild(tag);
      }
      tag.className = 'frag-active-indicator rec-tag';
      tag.innerHTML = '<span class="dot"></span>REC';
    } else if (isCurrent && isPlay) {
      if (!tag) {
        tag = document.createElement('span');
        const timeWrap = row.querySelector('.frag-top-line > div:first-child');
        if (timeWrap) timeWrap.appendChild(tag);
      }
      tag.className = 'frag-active-indicator play-tag';
      tag.textContent = 'PLAYING';
    } else if (tag) {
      tag.remove();
    }
  });
}

function formatSrtTimestamp(seconds) {
  const s = Math.max(0, seconds || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

let isExportingScript = false;

async function exportTimelineTranscript(format = 'txt') {
  if (isExportingScript) return;
  if (!state.fragments || state.fragments.length === 0) {
    return showNotice("No timeline lines available to export.", "warning");
  }

  const btn = el('exportTranscriptBtn');
  const progressFill = el('exportTranscriptProgressFill');
  const spinner = el('exportTranscriptSpinner');
  const icon = el('exportTranscriptIcon');
  const chevron = el('exportTranscriptChevron');
  const btnText = el('exportTranscriptBtnText');
  const extLabel = format === 'srt' ? '.SRT' : '.TXT';

  isExportingScript = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.remove('is-exported');
    btn.classList.add('is-exporting');
  }
  if (icon) icon.style.display = 'none';
  if (chevron) chevron.style.display = 'none';
  if (spinner) spinner.style.display = 'inline-block';
  if (progressFill) progressFill.style.width = '0%';
  if (btnText) btnText.textContent = `Preparing ${extLabel} 0%`;

  const exportStepper = createProgressStepper({
    fillEl: progressFill,
    onStep: (pct) => {
      if (btnText) btnText.textContent = `Preparing ${extLabel} ${pct}%`;
    },
    minStepMs: 4,
    maxStepMs: 7
  });

  try {
    const baseFileName = (state.file?.name || state.roomData?.videoName || 'timeline-transcript')
      .replace(/\.[^/.]+$/, '');
    const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    exportStepper.setTarget(35);

    let fileBlob;
    let downloadName;

    if (format === 'srt') {
      let srtContent = '';
      state.fragments.forEach((f, idx) => {
        const seq = idx + 1;
        const startSrt = formatSrtTimestamp(f.start);
        const endSrt = formatSrtTimestamp(f.end);
        const text = (f.transcript && f.transcript.trim()) ? f.transcript.trim() : `[Line ${seq}]`;
        srtContent += `${seq}\n${startSrt} --> ${endSrt}\n${text}\n\n`;
      });
      exportStepper.setTarget(75);
      fileBlob = new Blob([srtContent], { type: 'text/srt;charset=utf-8' });
      downloadName = `${baseFileName}-subtitles.srt`;
    } else {
      const now = new Date().toLocaleString();
      let txtContent = `Loop Booth - Full Master Timeline Transcript\n`;
      txtContent += `File: ${baseFileName}\n`;
      txtContent += `Date: ${now}\n`;
      txtContent += `Total Lines: ${state.fragments.length}\n`;
      txtContent += `Duration: ${formatTimecode(state.duration || 0)}\n`;
      txtContent += `==================================================\n\n`;

      state.fragments.forEach((f, idx) => {
        const lineNum = String(idx + 1).padStart(2, '0');
        const start = f.start.toFixed(1);
        const end = f.end.toFixed(1);
        const assigned = Array.isArray(f.assigned) ? f.assigned : [];
        let speakerNames = 'Unassigned';
        if (assigned.length > 0) {
          speakerNames = assigned.map(uid => {
            const p = roomPlayers.find(x => x.id === uid);
            return p ? p.name : (uid === state.uid ? (state.me?.name || 'You') : 'Player');
          }).join(', ');
        }
        const text = (f.transcript && f.transcript.trim()) ? f.transcript.trim() : `[No dialogue transcribed]`;
        txtContent += `[${lineNum}] ${start}s - ${end}s | Speaker: ${speakerNames}\n`;
        txtContent += `${text}\n\n`;
      });
      exportStepper.setTarget(75);
      fileBlob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
      downloadName = `${baseFileName}-transcript.txt`;
    }

    await exportStepper.finish(100);

    const url = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    if (spinner) spinner.style.display = 'none';
    if (btn) {
      btn.classList.remove('is-exporting');
      btn.classList.add('is-exported');
    }
    if (btnText) btnText.textContent = `Saved ${extLabel}`;
    showNotice(
      format === 'srt'
        ? `Exported transcript as .srt subtitles! (${state.fragments.length} lines)`
        : `Exported transcript as .txt file! (${state.fragments.length} lines)`,
      "success",
      4000
    );

    setTimeout(() => {
      if (btn) btn.classList.remove('is-exported');
      if (progressFill) progressFill.style.width = '0%';
      if (icon) icon.style.display = '';
      if (chevron) chevron.style.display = '';
      if (btnText) btnText.textContent = 'Export Script';
    }, 1500);
  } catch (err) {
    exportStepper.stop();
    console.error("Transcript export error:", err);
    showNotice("Failed to export transcript: " + (err?.message || "unknown error"), "error");
    if (spinner) spinner.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (icon) icon.style.display = '';
    if (chevron) chevron.style.display = '';
    if (btnText) btnText.textContent = 'Export Script';
    if (btn) btn.classList.remove('is-exporting', 'is-exported');
  } finally {
    isExportingScript = false;
    if (btn) btn.disabled = false;
  }
}

function setPauseButton(mode){
  const btn = el('pauseBtn');
  const hint = `<span class="key-hint">${escapeHtml(getHotkeyLabel('pause'))}</span>`;
  if(mode === 'paused'){ btn.innerHTML = `Resume ${hint}`; btn.disabled = false; }
  else if(mode === 'playing'){ btn.innerHTML = `Pause ${hint}`; btn.disabled = false; }
  else { btn.innerHTML = `Pause ${hint}`; btn.disabled = true; }
}

function sendPlaybackEvent(event){
  if(state.isSingleplayer || !state.roomId) return;
  multiplayer.api.sendRoomEvent(state.roomId, { ...event, sentAt: event.sentAt || Date.now(), originUid: state.uid, playerName: state.me?.name }).catch(error => {
    console.error('Playback sync error:', error);
  });
}

function handleRoomEvent(event){
  if(!event || event.originUid === state.uid) return;

  if (event.action === 'emote') {
    if (typeof spawnFloatingEmote === 'function') {
      spawnFloatingEmote({
        emoji: event.emoji || '👍',
        label: event.label || '',
        playerName: event.playerName || 'Player',
        playerColor: event.playerColor || '#B285F5',
      });
    }
    return;
  }

  if(event.action === 'player-activity'){
    state.playerActivities[event.uid] = {
      activity: event.activity,
      fragId: event.fragId,
      fragIndex: event.fragIndex,
      playerName: event.playerName,
      updatedAt: Date.now()
    };
    renderStudioPlayerList();
    renderFragmentList();
    return;
  }

  if(event.action === 'select-line'){
    const index = typeof event.index === 'number' ? event.index : state.fragments.findIndex(f => f.id === event.fragmentId);
    if(index >= 0 && index !== state.currentIndex){
      if(!state.pb || state.pb.mode !== 'record'){
        selectFragment(index, false, true);
      }
    }
    return;
  }

  if(event.action === 'sync-fragments'){
    if(Array.isArray(event.fragments) && event.fragments.length > 0){
      syncFragmentsFromDB(event.fragments);
    }
    return;
  }

  if(event.action === 'update-assignments'){
    const frag = state.fragments.find(f => f.id === event.fragmentId);
    if(frag){
      frag.assigned = event.assigned || [];
      renderFragmentList();
      renderMasterCanvas();
      if(state.fragments[state.currentIndex]?.id === event.fragmentId){
        renderAssignmentUI(frag);
        checkRecordAbility();
      }
    }
    return;
  }

  if(event.action === 'toggle-scoring'){
    state.scoringMode = Boolean(event.scoringMode);
    if(el('scoringToggle')) el('scoringToggle').checked = state.scoringMode;
    if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);
    if(el('studioScoreModeBadge')) el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';
    if(el('studioScreen')?.classList.contains('active')){
      updateLaneScoreDisplay(state.fragments[state.currentIndex]);
      renderFragmentList();
      renderStudioPlayerList();
    }
    return;
  }

  if(event.action === 'new-take'){
    (async () => {
      try {
        const res = await fetch(event.audio);
        const arr = await res.arrayBuffer();
        const ctx = ensureCtx();
        let buffer = await ctx.decodeAudioData(arr);

        let normalized = false;
        let normalizedDb = null;
        if (settings.get('autoNormalize')) {
          const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
          const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;
          const norm = normalizeAudioBuffer(ctx, buffer, targetDb, { silenceThresholdDb: silenceFloor });
          buffer = norm.buffer;
          normalized = !norm.wasGated;
          normalizedDb = norm.normalizedPeakDb;
        }

        if(!state.takes[event.fragId]) state.takes[event.fragId] = {};
        state.takes[event.fragId][event.uid] = { buffer, trace: event.trace, score: event.score || 0, normalized, normalizedDb };
        renderFragmentList();
        renderMasterCanvas();
        renderStudioPlayerList();
        if(state.fragments[state.currentIndex]?.id === event.fragId){
          drawWave(state.fragments[state.currentIndex]);
          updateLaneScoreDisplay(state.fragments[state.currentIndex]);
          checkRecordAbility();
        }
      } catch(err) {
        console.error("Failed to decode instant remote take:", err);
      }
    })();
    return;
  }

  if(event.action === 'start'){
    const index = state.fragments.findIndex(fragment => fragment.id === event.fragmentId);
    state.playerActivities[event.originUid] = {
      activity: event.mode === 'record' ? 'recording' : event.mode === 'review' ? 'reviewing' : 'listening',
      fragId: event.fragmentId,
      fragIndex: index >= 0 ? index : 0,
      playerName: event.playerName,
      updatedAt: Date.now()
    };
    renderStudioPlayerList();
    renderFragmentList();
    return;
  }

  if(event.action === 'stop' || event.action === 'pause'){
    if(event.originUid && state.playerActivities[event.originUid]){
      state.playerActivities[event.originUid].activity = event.action === 'pause' ? 'paused' : 'idle';
      renderStudioPlayerList();
      renderFragmentList();
    }
    return;
  }

  if(event.action === 'hard-sync-reset'){
    performHardMediaReset({
      isRemote: true,
      fragmentIndex: typeof event.fragmentIndex === 'number' ? event.fragmentIndex : state.currentIndex,
      initiatedBy: event.playerName || 'A player'
    });
    return;
  }

  if (event.action === 'party-redo') {
    if (event.fragId && state.takes[event.fragId]) {
      delete state.takes[event.fragId];
    }
    if (typeof stopPartyAudition === 'function') stopPartyAudition();
    if (typeof stopPartyFinalePlayback === 'function') stopPartyFinalePlayback();
    stopPlayback(true);
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
    const targetIdx = typeof event.fragmentIndex === 'number'
      ? Math.max(0, Math.min(Math.max(0, state.fragments.length - 1), event.fragmentIndex))
      : state.currentIndex;
    if (state.fragments[targetIdx]) {
      selectFragment(targetIdx, false, true);
    }
    if (typeof syncPartyUI === 'function') syncPartyUI();
    showNotice(`${event.playerName || 'Host'} triggered a Redo on Line ${targetIdx + 1} — record fresh takes!`, 'info', 3000);
    return;
  }

  if (event.action === 'party-spotlight') {
    if (typeof auditionSpotlightFromEvent === 'function') {
      auditionSpotlightFromEvent(event.candidateUid, event.fragmentIndex);
    }
    return;
  }
}

function startReviewSources(pb, offsetSeconds){
  const ctx = ensureCtx();
  if(ctx.state === 'suspended') ctx.resume().catch(() => {});
  const takes = state.takes[pb.frag.id] || {};
  pb.sources = [];
  const allTakeUids = new Set([...(pb.frag.assigned || []), ...Object.keys(takes)]);
  const isAutoNorm = Boolean(settings.get('autoNormalize'));
  const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
  const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;

  allTakeUids.forEach(uid => {
    if(takes[uid] && takes[uid].buffer){
      if (isAutoNorm && !takes[uid].normalized) {
        try {
          const norm = normalizeAudioBuffer(ctx, takes[uid].buffer, targetDb, { silenceThresholdDb: silenceFloor });
          takes[uid].buffer = norm.buffer;
          takes[uid].normalized = true;
          takes[uid].normalizedDb = norm.normalizedPeakDb;
        } catch(e) {
          console.warn("Failed to auto-normalize take on playback:", e);
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = takes[uid].buffer;
      src.connect(ctx.destination);
      const safeOffset = Math.max(0, Math.min(offsetSeconds, src.buffer.duration - 0.01));
      src.start(0, safeOffset);
      pb.sources.push(src);
    }
  });
  pb.sourcesStartedAtCtxTime = ctx.currentTime;
  pb.sourcesOffsetAtStart = offsetSeconds;
}

async function playFragment(mode, isRemote = false, remoteLabel = '', startPosition = 0, sentAt = Date.now()){
  stopPlayback(isRemote);
  const f = state.fragments[state.currentIndex];
  if(!f) return;
  const ctx = ensureCtx();
  if(ctx.state === 'suspended') ctx.resume().catch(() => {});
  const v = el('mainVideo');
  
  if (!v.src || v.src === '' || v.src === window.location.href) {
    if (state.file) {
      if (state.videoURL) URL.revokeObjectURL(state.videoURL);
      state.videoURL = URL.createObjectURL(state.file);
      v.src = state.videoURL;
    } else if (state.roomId && !state.isSingleplayer) {
      v.src = `/api/rooms/${state.roomId}/video`;
    }
    try { v.load(); } catch(e) {}
  }
  
  if(mode === 'record'){
    try{
      if(!state.micStream) {
        state.micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
      }
    }catch(err){
      console.error("Microphone access error:", err);
      let errMsg = "Microphone access blocked or unavailable.";
      if(err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'){
        errMsg = "Microphone permission denied. Allow mic access in your browser to record.";
      } else if(err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError'){
        errMsg = "No microphone found. Please connect an audio input device.";
      } else if(err.name === 'NotReadableError' || err.name === 'TrackStartError'){
        errMsg = "Microphone is in use by another application.";
      }
      showNotice(errMsg, 'error');
      return;
    }
  }

  const mixVol = getMixVolume();
  v.muted = isRemote || mode === 'record' || (mode === 'review' && mixVol <= 0);
  v.volume = isRemote || mode === 'record' ? 0 : mixVol;
  v.playbackRate = 1;
  try {
    v.currentTime = f.start;
  } catch(e) {}
  
  // Wait briefly for seek to settle if needed
  await new Promise(r => {
    if(Math.abs((v.currentTime || 0) - f.start) < 0.05) return r();
    let settled = false;
    const onSeek = () => { if(!settled){ settled = true; v.removeEventListener('seeked', onSeek); r(); } };
    v.addEventListener('seeked', onSeek);
    setTimeout(onSeek, 200);
  });
  if(isRemote && startPosition > 0){
    try {
      v.currentTime = Math.min(f.end - 0.01, f.start + startPosition + Math.max(0, (Date.now() - sentAt) / 1000));
    } catch(e) {}
  }

  const pb = {
    mode,
    frag: f,
    sources: [],
    recorder: null,
    chunks: [],
    analyser: null,
    sourcesOffsetAtStart: 0,
    remote: isRemote,
    startedAt: performance.now(),
    hasPlayed: false,
    duration: Math.max(0.1, f.end - f.start)
  };
  state.pb = pb;
  
  if(mode === 'record'){
    try {
      const micSrc = ctx.createMediaStreamSource(state.micStream);
      pb.analyser = ctx.createAnalyser();
      pb.analyser.fftSize = 1024;
      micSrc.connect(pb.analyser);
      
      const mimeOpts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => {
        try { return MediaRecorder.isTypeSupported(m); } catch(e){ return false; }
      });
      pb.recorder = new MediaRecorder(state.micStream, mimeOpts ? {mimeType: mimeOpts} : undefined);
      
      pb.recorder.ondataavailable = e => { if(e.data.size) pb.chunks.push(e.data); };
      const waveWidth = Math.round(el('waveCanvas').getBoundingClientRect().width) || 300;
      state.liveTrace = new Array(waveWidth).fill(0);
      pb.recorder.start();
      el('monitorBadgeText').textContent = "Recording"; el('monitorBadge').classList.add('live');
      el('recordBtn').classList.add('is-armed');
      el('recordBtn').classList.add('is-recording');
      el('recordBtn').innerHTML = `<span class="rec-dot-pulse" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-right:6px;animation:rec-pulse 0.7s infinite alternate;"></span>Recording... <span class="key-hint">${escapeHtml(getHotkeyLabel('record'))}</span>`;

      // Visual Recording HUD Timer & Real-Time Progress in .monitor
      if (el('monitorRecTimer')) el('monitorRecTimer').style.display = 'inline-flex';
      if (el('monitorRecBar')) el('monitorRecBar').style.display = 'block';
      if (el('studioMonitor')) el('studioMonitor').classList.add('is-recording');
      if (el('monitorRecTime')) el('monitorRecTime').textContent = '0:00.0';
      const lineDur = Math.max(0.05, f.end - f.start);
      if (el('monitorRecTarget')) el('monitorRecTarget').textContent = `/ ${formatTimeSecTenths(lineDur)}`;
      if (el('monitorRecBarFill')) el('monitorRecBarFill').style.width = '0%';

      if(!isRemote) broadcastMyActivity('recording', f.id, state.currentIndex);
    } catch(recErr) {
      console.error("Audio recording start error:", recErr);
      showNotice("Could not start audio recorder: " + (recErr.message || "recording device error"), 'error');
      stopPlayback(isRemote);
      return;
    }
  } else if (mode === 'review'){
    startReviewSources(pb, 0);
    el('monitorBadgeText').textContent = "Playing Takes"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('reviewing', f.id, state.currentIndex);
  } else {
    v.volume = isRemote ? 0 : 1.0;
    el('monitorBadgeText').textContent = remoteLabel || "Original"; el('monitorBadge').classList.toggle('live', Boolean(remoteLabel));
    if(!isRemote) broadcastMyActivity('listening', f.id, state.currentIndex);
  }

  state.isPlaying = true; state.paused = false;
  setPauseButton('playing');
  updateActiveFragmentHighlight();
  updateMonitorSubtitle();

  const onPlaying = () => {
    if(state.pb === pb) pb.hasPlayed = true;
    v.removeEventListener('playing', onPlaying);
  };
  v.addEventListener('playing', onPlaying);

  const playPromise = v.play();
  playPromise?.then(() => {
    if(state.pb === pb) pb.hasPlayed = true;
  }).catch(error => {
    if (!v.muted) {
      v.muted = true;
      v.play().then(() => {
        if(state.pb === pb) pb.hasPlayed = true;
      }).catch(e => {
        console.warn('Muted playback also blocked:', e);
        showNotice("Video autoplay was blocked by browser. Click anywhere on page to activate.", 'warning');
      });
    } else {
      console.warn('Playback could not start:', error);
      showNotice("Video playback could not start: " + (error?.message || "browser restriction"), 'error');
    }
  });
  runLoop();
}

function runLoop(){
  const loop = () => {
    const pb = state.pb;
    if(!pb || !state.isPlaying || state.paused) return;
    const v = el('mainVideo');
    const f = pb.frag;
    const dur = Math.max(0.05, f.end - f.start);
    const progress = Math.min(1, Math.max(0, v.currentTime - f.start) / dur);
    
    if(pb.mode === 'record'){
      const elapsed = Math.max(0, (performance.now() - pb.startedAt) / 1000);
      const recPercent = Math.min(100, (elapsed / dur) * 100);
      if(el('monitorRecTime')) el('monitorRecTime').textContent = formatTimeSecTenths(elapsed);
      if(el('monitorRecBarFill')) el('monitorRecBarFill').style.width = `${recPercent}%`;

      if(pb.analyser){
        const data = new Uint8Array(pb.analyser.fftSize);
        pb.analyser.getByteTimeDomainData(data);
        let sum = 0; for(let i=0;i<data.length;i++) sum += Math.pow((data[i]-128)/128, 2);
        const rms = Math.sqrt(sum/data.length);
        const idx = Math.min(state.liveTrace.length-1, Math.floor(progress * state.liveTrace.length));
        state.liveTrace[idx] = Math.min(1, rms * 2.2);
      }
    }
    
    drawWave(f, progress);
    renderMasterCanvas();
    
    const elapsed = (performance.now() - pb.startedAt) / 1000;
    const hasStarted = pb.hasPlayed || elapsed > 0.25;
    const reachedEndByClock = hasStarted && (v.currentTime >= f.end - 0.04) && (v.currentTime >= f.start + 0.08);
    const reachedEndByEnded = hasStarted && v.ended && (v.currentTime >= f.start + 0.08);
    const reachedEndByWallClock = elapsed >= dur + 0.05;

    if(reachedEndByClock || reachedEndByEnded || reachedEndByWallClock){
      finishPlayback(pb.remote);
    } else {
      state.rafId = requestAnimationFrame(loop);
    }
  };
  state.rafId = requestAnimationFrame(loop);
}

function pausePlayback(isRemote = false){
  const pb = state.pb;
  if(!pb || !state.isPlaying || state.paused) return;
  state.paused = true;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId = null; }
  const v = el('mainVideo');
  v.pause();
  if(pb.mode === 'record' && pb.recorder && pb.recorder.state === 'recording'){
    try{ pb.recorder.pause(); }catch(e){}
    const statusTag = el('monitorRecTimer')?.querySelector('.rec-status-tag');
    if (statusTag) statusTag.textContent = 'PAUSED';
  }
  if(pb.mode === 'review' && pb.sources && pb.sources.length){
    const ctx = ensureCtx();
    const elapsed = ctx.currentTime - pb.sourcesStartedAtCtxTime;
    pb.sourcesOffsetAtStart = pb.sourcesOffsetAtStart + elapsed;
    pb.sources && pb.sources.forEach(s => { try{ s.stop(); }catch(e){} });
    pb.sources = [];
  }
  el('monitorBadgeText').textContent = "Paused"; el('monitorBadge').classList.remove('live');
  setPauseButton('paused');
  updateActiveFragmentHighlight();
  updateMonitorSubtitle();
  if(!isRemote){
    broadcastMyActivity('paused', pb?.frag?.id, state.currentIndex);
    sendPlaybackEvent({ action:'pause', fragmentId:pb.frag.id, position:Math.max(0, v.currentTime - pb.frag.start) });
  }
}

function resumePlayback(isRemote = false){
  const pb = state.pb;
  if(!pb || !state.paused) return;
  state.paused = false;
  const v = el('mainVideo');
  if(pb.mode === 'record' && pb.recorder && pb.recorder.state === 'paused'){
    try{ pb.recorder.resume(); }catch(e){}
    el('monitorBadgeText').textContent = "Recording"; el('monitorBadge').classList.add('live');
    const statusTag = el('monitorRecTimer')?.querySelector('.rec-status-tag');
    if (statusTag) statusTag.textContent = 'REC';
    if(!isRemote) broadcastMyActivity('recording', pb?.frag?.id, state.currentIndex);
  } else if(pb.mode === 'review'){
    const mixVol = getMixVolume();
    v.muted = pb.remote || mixVol <= 0;
    v.volume = pb.remote ? 0 : mixVol;
    startReviewSources(pb, pb.sourcesOffsetAtStart || 0);
    el('monitorBadgeText').textContent = "Playing Takes"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('reviewing', pb?.frag?.id, state.currentIndex);
  } else {
    v.muted = Boolean(pb.remote);
    v.volume = pb.remote ? 0 : 1.0;
    el('monitorBadgeText').textContent = "Original"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('listening', pb?.frag?.id, state.currentIndex);
  }
  v.playbackRate = 1;
  v.play();
  setPauseButton('playing');
  updateActiveFragmentHighlight();
  updateMonitorSubtitle();
  runLoop();
  if(!isRemote) sendPlaybackEvent({ action:'resume', fragmentId:pb.frag.id, position:Math.max(0, v.currentTime - pb.frag.start) });
}

if (el('pauseBtn')) {
  el('pauseBtn').onclick = () => {
    if(state.paused) resumePlayback();
    else if(state.isPlaying) pausePlayback();
  };
}

function finishPlayback(isRemote = false){
  state.isPlaying = false; state.paused = false;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId = null; }
  const v = el('mainVideo');
  v.pause();
  el('monitorBadgeText').textContent = "Idle"; el('monitorBadge').classList.remove('live');
  el('recordBtn').classList.remove('is-armed');
  el('recordBtn').classList.remove('is-recording');
  el('recordBtn').innerHTML = `Record Take <span class="key-hint">${escapeHtml(getHotkeyLabel('record'))}</span>`;

  // Reset recording HUD in monitor
  if (el('monitorRecTimer')) el('monitorRecTimer').style.display = 'none';
  if (el('monitorRecBar')) el('monitorRecBar').style.display = 'none';
  if (el('studioMonitor')) el('studioMonitor').classList.remove('is-recording');

  setPauseButton('idle');
  updateActiveFragmentHighlight();
  updateMonitorSubtitle();
  if(!isRemote) broadcastMyActivity('idle');
  
  const pb = state.pb;
  if(pb){
    if(pb.syncTimer) clearInterval(pb.syncTimer);
    pb.sources && pb.sources.forEach(s => { try{ s.stop(); }catch(e){} });
    if(pb.mode === 'record' && pb.recorder){
      const fragId = pb.frag.id;
      const trace = [...state.liveTrace];
      pb.recorder.onstop = async () => {
        if(pb.chunks.length === 0) return;
        const mimeType = pb.chunks[0].type || 'audio/webm';
        const blob = new Blob(pb.chunks, { type: mimeType });
        if(blob.size < 50) return; // Ignore empty or invalid tiny recordings

        try {
          // Decode locally immediately for instant feedback
          const arr = await blob.arrayBuffer();
          const ctx = ensureCtx();
          let buffer = await ctx.decodeAudioData(arr);

          // Auto-Normalization
          let wasNormalized = false;
          let normalizedDb = null;
          if (settings.get('autoNormalize')) {
            const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
            const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;
            const norm = normalizeAudioBuffer(ctx, buffer, targetDb, { silenceThresholdDb: silenceFloor });
            buffer = norm.buffer;
            wasNormalized = !norm.wasGated;
            normalizedDb = norm.normalizedPeakDb;
          }

          let takeScore = 0;
          if (state.scoringMode) {
            takeScore = computeWaveMatchScore(pb.frag, buffer, trace);
          }

          if(!state.takes[fragId]) state.takes[fragId] = {};
          state.takes[fragId][state.uid] = { buffer, trace, score: takeScore, normalized: wasNormalized, normalizedDb };
          renderFragmentList();
          renderMasterCanvas();
          renderStudioPlayerList();
          if(state.fragments[state.currentIndex]?.id === fragId){
            drawWave(state.fragments[state.currentIndex]);
            updateLaneScoreDisplay(state.fragments[state.currentIndex]);
          }
          checkRecordAbility();
          persistCurrentSession();

          if (state.scoringMode) {
            const tierInfo = getScoreTier(takeScore);
            showNotice(`★ Wave Match: ${takeScore}% (${tierInfo.label})`, tierInfo.toastType, 3600);
          } else if (isPartyMode()) {
            showNotice("Take locked in! Waiting for host to open voting.", "success", 2600);
          } else if (wasNormalized) {
            showNotice(`Take leveled to ${normalizedDb} dBFS`, "info", 2000);
          }

          if (settings.get('autoAdvance') && !isPartyMode() && state.currentIndex < state.fragments.length - 1) {
            setTimeout(() => {
              if (!state.isPlaying && !state.paused) {
                selectFragment(state.currentIndex + 1);
              }
            }, 600);
          }
        } catch(decErr) {
          console.error("Local take decode error:", decErr);
          showNotice("Failed to decode your recorded audio take.", "error");
        }

        if (isSoloSession()) return;

        // In multiplayer, send take to peers immediately & save to room storage
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          try {
            const base64 = reader.result;
            const currentScore = state.takes[fragId]?.[state.uid]?.score || 0;

            sendPlaybackEvent({
              action: 'new-take',
              fragId,
              uid: state.uid,
              audio: base64,
              trace,
              score: currentScore
            });

            const fb = await loadFirebase();
            if(!fb) return;
            const takeRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'takes_' + state.roomId, `take_${fragId}_${state.uid}`);
            await fb.setDoc(takeRef, {
              takeRoomId: state.roomId,
              fragId,
              uid: state.uid,
              audio: base64,
              trace,
              score: currentScore
            });

            if (isPartyMode() && state.roomId) {
              await multiplayer.api.partyAction(state.roomId, {
                action: 'mark-submitted',
                fragId,
                uid: state.uid,
                actorUid: state.uid
              }).catch(() => {});
            }
          } catch (err) {
            console.error("Multiplayer take upload error:", err);
            showNotice("Failed to sync take with room server.", "warning");
          }
        };
      };
      try{ if(pb.recorder.state !== 'inactive') pb.recorder.stop(); }catch(e){}
    }
  }
  state.pb = null;
  if(state.fragments[state.currentIndex]) drawWave(state.fragments[state.currentIndex]);
  if(!isRemote) sendPlaybackEvent({ action:'stop' });
}

function stopPlayback(isRemote = false){
  // Full abort (switching fragments, leaving studio, etc) -- discards any in-flight recording.
  state.isPlaying = false; state.paused = false;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId = null; }
  const v = el('mainVideo');
  if (v) v.pause();
  const pb = state.pb;
  if(pb){
    if(pb.syncTimer) clearInterval(pb.syncTimer);
    pb.sources && pb.sources.forEach(s => { try{ s.stop(); s.disconnect(); }catch(e){} });
    if(pb.analyser){ try{ pb.analyser.disconnect(); }catch(e){} }
    if(pb.recorder && pb.recorder.state !== 'inactive'){
      try{ pb.recorder.stop(); }catch(e){}
    }
  }
  state.pb = null;
  el('monitorBadgeText').textContent = "Idle"; el('monitorBadge').classList.remove('live');
  el('recordBtn').classList.remove('is-armed');
  el('recordBtn').classList.remove('is-recording');
  el('recordBtn').innerHTML = `Record Take <span class="key-hint">${escapeHtml(getHotkeyLabel('record'))}</span>`;

  // Reset recording HUD in monitor
  if (el('monitorRecTimer')) el('monitorRecTimer').style.display = 'none';
  if (el('monitorRecBar')) el('monitorRecBar').style.display = 'none';
  if (el('studioMonitor')) el('studioMonitor').classList.remove('is-recording');

  setPauseButton('idle');
  updateActiveFragmentHighlight();
  updateMonitorSubtitle();
  if(!isRemote){
    broadcastMyActivity('idle');
    sendPlaybackEvent({ action:'stop' });
  }
}

let isHardSyncing = false;

async function performHardMediaReset({ isRemote = false, fragmentIndex = state.currentIndex, initiatedBy = '' } = {}) {
  if (isHardSyncing) return;
  isHardSyncing = true;

  const syncBtn = el('monitorSyncBtn');
  const syncBtnText = el('monitorSyncBtnText');
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.classList.remove('is-synced');
    syncBtn.classList.add('is-syncing');
  }
  if (syncBtnText) syncBtnText.textContent = 'Syncing...';

  try {
    // 1. Abort all active playback, timers, RAF loops, and source nodes
    stopPlayback(true);

    // 2. Hard-reset Web Audio Context & rebuild audio buffers
    if (state.audioCtx) {
      try {
        await state.audioCtx.close();
      } catch (closeErr) {}
      state.audioCtx = null;
    }
    const freshCtx = ensureCtx();
    if (freshCtx && freshCtx.state === 'suspended') {
      await freshCtx.resume().catch(() => {});
    }

    if (state.file) {
      try {
        const arr = await state.file.arrayBuffer();
        state.masterBuffer = await freshCtx.decodeAudioData(arr.slice(0));
        state.envelope = buildEnvelope(state.masterBuffer, 50);
        state.backgroundBuffer = buildVocalReducedBuffer(state.masterBuffer);
      } catch (audioErr) {
        console.warn("Hard sync audio re-decode fallback:", audioErr);
      }
    }

    // Re-clone all cached take AudioBuffers cleanly onto the fresh AudioContext
    for (const fragId of Object.keys(state.takes || {})) {
      const fragTakes = state.takes[fragId];
      if (!fragTakes) continue;
      for (const uid of Object.keys(fragTakes)) {
        const takeObj = fragTakes[uid];
        const oldBuf = takeObj?.buffer;
        if (oldBuf && typeof oldBuf.getChannelData === 'function' && freshCtx) {
          try {
            const freshBuf = freshCtx.createBuffer(
              oldBuf.numberOfChannels,
              oldBuf.length,
              oldBuf.sampleRate
            );
            for (let ch = 0; ch < oldBuf.numberOfChannels; ch++) {
              freshBuf.copyToChannel(oldBuf.getChannelData(ch), ch);
            }
            takeObj.buffer = freshBuf;
            delete takeObj._masterEnv;
          } catch (bufErr) {
            console.warn("Take buffer clone notice during sync:", bufErr);
          }
        }
      }
    }

    // 3. Hard-reset the HTML5 <video> pipeline & seek to aligned line start
    const v = el('mainVideo');
    if (v) {
      try { v.pause(); } catch (e) {}
      v.playbackRate = 1;
      if (state.file) {
        if (state.videoURL) {
          try { URL.revokeObjectURL(state.videoURL); } catch (e) {}
        }
        state.videoURL = URL.createObjectURL(state.file);
        v.src = state.videoURL;
      } else if (state.roomId && !state.isSingleplayer) {
        v.src = `/api/rooms/${state.roomId}/video?sync=${Date.now()}`;
      }

      if (v.src) {
        try { v.load(); } catch (e) {}
        await new Promise((resolve) => {
          if (v.readyState >= 2) return resolve();
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            v.removeEventListener('loadeddata', finish);
            v.removeEventListener('canplay', finish);
            resolve();
          };
          v.addEventListener('loadeddata', finish);
          v.addEventListener('canplay', finish);
          setTimeout(finish, 1500);
        });
      }
    }

    // 4. Re-align current fragment index, video timestamp, waveforms, and UI
    if (state.fragments.length > 0) {
      const targetIdx = typeof fragmentIndex === 'number'
        ? Math.max(0, Math.min(state.fragments.length - 1, fragmentIndex))
        : state.currentIndex;
      state.currentIndex = targetIdx;
      const targetFrag = state.fragments[targetIdx];
      if (targetFrag) {
        if (el('fragLabel')) el('fragLabel').textContent = targetIdx + 1;
        if (el('fragTotal')) el('fragTotal').textContent = state.fragments.length;
        if (v && Number.isFinite(targetFrag.start)) {
          try { v.currentTime = targetFrag.start; } catch (e) {}
        }
        renderAssignmentUI(targetFrag);
        drawWave(targetFrag, 0);
        updateLaneScoreDisplay(targetFrag);
        updateActiveLineTranscriptUI();
        checkRecordAbility();
      }
    }

    renderFragmentList();
    renderMasterCanvas();
    updateActiveFragmentHighlight();
    updateMonitorSubtitle();
    broadcastMyActivity('idle');

    if (syncBtn) {
      syncBtn.classList.remove('is-syncing');
      syncBtn.classList.add('is-synced');
    }
    if (syncBtnText) syncBtnText.textContent = 'Synced';
    setTimeout(() => {
      if (syncBtn) syncBtn.classList.remove('is-synced');
      if (syncBtnText) syncBtnText.textContent = 'Sync';
    }, 1400);

    if (isRemote) {
      showNotice(
        `${initiatedBy || 'Teammate'} triggered Sync — audio buffers & video hard-reset.`,
        "info",
        3000
      );
    } else if (!isSoloSession() && state.roomId) {
      showNotice(
        "Hard Sync complete — audio buffers & video reset across all connected clients.",
        "success",
        3000
      );
    } else {
      showNotice("Hard Sync complete — audio buffers & video element reset.", "success", 2400);
    }
  } catch (err) {
    console.error("Hard sync error:", err);
    showNotice("Could not complete hard sync reset: " + (err?.message || "media error"), "error");
    if (syncBtn) syncBtn.classList.remove('is-syncing', 'is-synced');
    if (syncBtnText) syncBtnText.textContent = 'Sync';
  } finally {
    if (syncBtn) syncBtn.disabled = false;
    isHardSyncing = false;
  }
}

if (el('monitorSyncBtn')) {
  el('monitorSyncBtn').onclick = () => {
    if (isHardSyncing) return;
    if (!isSoloSession() && state.roomId) {
      sendPlaybackEvent({
        action: 'hard-sync-reset',
        fragmentIndex: state.currentIndex,
        syncAt: Date.now()
      });
    }
    performHardMediaReset({
      isRemote: false,
      fragmentIndex: state.currentIndex
    });
  };
}

if (el('listenBtn')) {
  el('listenBtn').onclick = () => {
    const f = state.fragments[state.currentIndex];
    if(!f) return showNotice("No line selected.", "warning");
    playFragment('original');
  };
}

if (el('recordBtn')) {
  el('recordBtn').onclick = async () => {
    const f = state.fragments[state.currentIndex];
    if(!f) return showNotice("No line selected to record.", "warning");
    if(f.end - f.start < 0.2){
      return showNotice("This line is too short to record (< 0.2s). Try merging it with an adjacent line.", "warning", 3000);
    }
    if (isPartyMode()) {
      const party = getPartyState();
      if (party && party.phase !== 'recording') {
        return showNotice("Recording is closed right now — wait for the next line round.", "warning", 2400);
      }
      playFragment('record');
      return;
    }
    const assigned = Array.isArray(f.assigned) ? f.assigned : [];
    if(!isSoloSession() && !assigned.includes(state.uid)){
      if(assigned.length < 2){
        f.assigned = [...assigned, state.uid];
        renderAssignmentUI(f);
        renderFragmentList();
        checkRecordAbility();
        sendPlaybackEvent({
          action: 'update-assignments',
          fragmentId: f.id,
          assigned: f.assigned
        });
        const fb = await loadFirebase();
        if(fb && state.roomId){
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          fb.updateDoc(roomRef, { fragments: state.fragments }).catch(() => {});
        }
      } else {
        return showNotice("Max 2 players per line. Uncheck another player to assign yourself.");
      }
    }
    playFragment('record');
  };
}

if (el('reviewBtn')) {
  el('reviewBtn').onclick = () => {
    const f = state.fragments[state.currentIndex];
    if(!f) return showNotice("No line selected.", "warning");
    const takes = state.takes[f.id] || {};
    if(Object.keys(takes).length === 0){
      return showNotice("No takes recorded for this line yet. Hit Record to lay one down!", "info", 2400);
    }
    playFragment('review');
  };
}

if (el('voiceToTextBtn')) {
  el('voiceToTextBtn').onclick = (e) => {
    if (e.shiftKey) {
      transcribeAllFragments();
    } else {
      transcribeActiveLine();
    }
  };
}

const activeLineTranscriptEl = el('activeLineTranscriptText');
if (activeLineTranscriptEl) {
  activeLineTranscriptEl.addEventListener('focus', () => {
    const f = state.fragments[state.currentIndex];
    if (!f || !f.transcript) {
      activeLineTranscriptEl.textContent = '';
      activeLineTranscriptEl.style.fontStyle = 'normal';
      activeLineTranscriptEl.style.color = '#F5EDFF';
    }
  });

  activeLineTranscriptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      activeLineTranscriptEl.blur();
    }
  });

  activeLineTranscriptEl.addEventListener('blur', () => {
    const f = state.fragments[state.currentIndex];
    if (!f) return;
    const val = activeLineTranscriptEl.textContent.trim();
    const isPlaceholder = !val || 
      val === 'Click Voice-to-Text or click to type script...' ||
      val === 'Click Voice-to-Text or type script here...' ||
      val === 'No transcript generated yet. Click "Voice-to-Text" to transcribe.' ||
      val === 'Select a line or click Transcribe to generate...';

    if (!isPlaceholder) {
      f.transcript = val;
    } else {
      f.transcript = '';
    }
    updateActiveLineTranscriptUI(f);
    broadcastFragments(state.fragments);
    persistCurrentSession();
  });
}

const exportScriptBtn = el('exportTranscriptBtn');
const exportScriptMenu = el('exportTranscriptMenu');
if (exportScriptBtn && exportScriptMenu) {
  exportScriptBtn.onclick = (e) => {
    e.stopPropagation();
    const isShown = exportScriptMenu.style.display !== 'none';
    exportScriptMenu.style.display = isShown ? 'none' : 'flex';
  };

  if (el('exportTranscriptTxtBtn')) {
    el('exportTranscriptTxtBtn').onclick = (e) => {
      e.stopPropagation();
      exportScriptMenu.style.display = 'none';
      exportTimelineTranscript('txt');
    };
  }

  if (el('exportTranscriptSrtBtn')) {
    el('exportTranscriptSrtBtn').onclick = (e) => {
      e.stopPropagation();
      exportScriptMenu.style.display = 'none';
      exportTimelineTranscript('srt');
    };
  }

  document.addEventListener('click', (e) => {
    if (!el('exportTranscriptDropdownWrap')?.contains(e.target)) {
      if (exportScriptMenu) exportScriptMenu.style.display = 'none';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exportScriptMenu && exportScriptMenu.style.display !== 'none') {
      exportScriptMenu.style.display = 'none';
    }
  });
}

const exportConfig = {
  mode: 'final',          // 'final' | 'vocals'
  includeSubtitles: false,
  videoFormat: 'webm',    // 'webm' | 'mp4' | 'mkv'
  audioFormat: 'wav',     // 'wav' | 'webm' | 'mp4'
};

const VIDEO_FORMAT_CANDIDATES = {
  webm: {
    ext: 'webm',
    mimeBase: 'video/webm',
    label: 'WebM',
    candidates: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'],
  },
  mp4: {
    ext: 'mp4',
    mimeBase: 'video/mp4',
    label: 'MP4',
    candidates: [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=vp9,opus',
      'video/mp4',
    ],
  },
  mkv: {
    ext: 'mkv',
    mimeBase: 'video/x-matroska',
    label: 'MKV',
    candidates: ['video/x-matroska;codecs=avc1,opus', 'video/x-matroska;codecs=vp9,opus', 'video/x-matroska'],
  },
};

const AUDIO_FORMAT_CANDIDATES = {
  wav: {
    ext: 'wav',
    mimeBase: 'audio/wav',
    label: 'WAV',
    candidates: ['audio/wav'],
  },
  webm: {
    ext: 'webm',
    mimeBase: 'audio/webm',
    label: 'WebM',
    candidates: ['audio/webm;codecs=opus', 'audio/webm'],
  },
  mp4: {
    ext: 'm4a',
    mimeBase: 'audio/mp4',
    label: 'M4A',
    candidates: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
  },
};

function getSupportedVideoMime(fmtKey) {
  const spec = VIDEO_FORMAT_CANDIDATES[fmtKey] || VIDEO_FORMAT_CANDIDATES.webm;
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return fmtKey === 'webm' ? spec.candidates[0] : null;
  }
  return spec.candidates.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  }) || null;
}

function getSupportedAudioMime(fmtKey) {
  if (fmtKey === 'wav') return 'audio/wav';
  const spec = AUDIO_FORMAT_CANDIDATES[fmtKey];
  if (!spec) return null;
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  return spec.candidates.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  }) || null;
}

function getFormattedDownloadSummary() {
  if (exportConfig.mode === 'vocals') {
    const ext = (AUDIO_FORMAT_CANDIDATES[exportConfig.audioFormat] || AUDIO_FORMAT_CANDIDATES.wav).ext;
    return `Download Vocals (.${ext})`;
  }
  const ext = (VIDEO_FORMAT_CANDIDATES[exportConfig.videoFormat] || VIDEO_FORMAT_CANDIDATES.webm).ext;
  const subTag = exportConfig.includeSubtitles ? ' + Subs' : '';
  return `Download Final (.${ext}${subTag})`;
}

function setDownloadButtonState(stateMode, customLabel = null) {
  const renderBtn = el('renderBtn');
  const arrowBtn = el('downloadOptionsBtn');
  const goBtn = el('dlMenuStartBtn');
  if (!renderBtn) return;

  if (stateMode === 'busy') {
    renderBtn.disabled = true;
    renderBtn.classList.remove('is-success');
    if (arrowBtn) {
      arrowBtn.disabled = true;
      arrowBtn.classList.remove('is-success');
    }
    if (goBtn) goBtn.disabled = true;
    renderBtn.innerHTML = `
      <span class="export-btn-spinner" aria-hidden="true" style="display:inline-block;"></span>
      <span id="renderBtnLabel">${escapeHtml(customLabel || 'Exporting...')}</span>
    `;
    return;
  }

  if (stateMode === 'success') {
    renderBtn.disabled = false;
    renderBtn.classList.add('is-success');
    if (arrowBtn) {
      arrowBtn.disabled = false;
      arrowBtn.classList.add('is-success');
    }
    if (goBtn) goBtn.disabled = false;
    renderBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><polyline points="20 6 9 17 4 12"></polyline></svg>
      <span id="renderBtnLabel">${escapeHtml(customLabel || 'Ready to Save!')}</span>
    `;
    return;
  }

  // idle
  renderBtn.disabled = false;
  renderBtn.classList.remove('is-success');
  if (arrowBtn) {
    arrowBtn.disabled = false;
    arrowBtn.classList.remove('is-success');
  }
  if (goBtn) goBtn.disabled = false;
  const label = customLabel || getFormattedDownloadSummary();
  renderBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
    <span id="renderBtnLabel">${escapeHtml(label)}</span>
  `;
}

function closeDownloadOptionsMenu() {
  const menu = el('downloadOptionsMenu');
  const arrowBtn = el('downloadOptionsBtn');
  if (menu) menu.style.display = 'none';
  if (arrowBtn) arrowBtn.setAttribute('aria-expanded', 'false');
}

function syncDownloadOptionsUI() {
  if (typeof document === 'undefined') return;

  // Ensure selected format is accessible in the current browser
  if (!getSupportedVideoMime(exportConfig.videoFormat)) {
    const fallbackVideo = ['webm', 'mp4', 'mkv'].find((k) => Boolean(getSupportedVideoMime(k)));
    if (fallbackVideo) exportConfig.videoFormat = fallbackVideo;
  }
  if (!getSupportedAudioMime(exportConfig.audioFormat)) {
    exportConfig.audioFormat = 'wav';
  }

  document.querySelectorAll('[data-dl-mode]').forEach((btn) => {
    const isSel = btn.getAttribute('data-dl-mode') === exportConfig.mode;
    btn.classList.toggle('is-selected', isSel);
    btn.setAttribute('aria-checked', isSel ? 'true' : 'false');
  });

  const subSection = el('dlSubtitleSection');
  const vidSection = el('dlVideoFormatSection');
  const audSection = el('dlAudioFormatSection');
  const isVocals = exportConfig.mode === 'vocals';

  if (subSection) subSection.style.display = isVocals ? 'none' : '';
  if (vidSection) vidSection.style.display = isVocals ? 'none' : '';
  if (audSection) audSection.style.display = isVocals ? '' : 'none';

  const subToggle = el('dlIncludeSubtitlesToggle');
  if (subToggle) subToggle.checked = Boolean(exportConfig.includeSubtitles);

  document.querySelectorAll('[data-dl-video-format]').forEach((btn) => {
    const fmt = btn.getAttribute('data-dl-video-format');
    const supported = Boolean(getSupportedVideoMime(fmt));
    btn.disabled = !supported;
    btn.classList.toggle('is-selected', fmt === exportConfig.videoFormat && supported);
    const tag = btn.querySelector(`[data-fmt-tag="${fmt}"]`);
    if (tag) {
      tag.textContent = supported ? `.${VIDEO_FORMAT_CANDIDATES[fmt]?.ext || fmt}` : 'N/A';
    }
    btn.title = supported
      ? `Export video as .${VIDEO_FORMAT_CANDIDATES[fmt]?.ext || fmt}`
      : `${(fmt || '').toUpperCase()} encoding is not supported by this browser`;
  });

  document.querySelectorAll('[data-dl-audio-format]').forEach((btn) => {
    const fmt = btn.getAttribute('data-dl-audio-format');
    const supported = Boolean(getSupportedAudioMime(fmt));
    btn.disabled = !supported;
    btn.classList.toggle('is-selected', fmt === exportConfig.audioFormat && supported);
    const tag = btn.querySelector(`[data-audio-tag="${fmt}"]`);
    if (tag) {
      tag.textContent = supported
        ? (fmt === 'wav' ? 'Lossless' : `.${AUDIO_FORMAT_CANDIDATES[fmt]?.ext || fmt}`)
        : 'N/A';
    }
    btn.title = supported
      ? `Export vocals as ${AUDIO_FORMAT_CANDIDATES[fmt]?.label || fmt}`
      : `${(fmt || '').toUpperCase()} audio encoding is not supported by this browser`;
  });

  const renderBtn = el('renderBtn');
  if (renderBtn && !renderBtn.disabled && !renderBtn.classList.contains('is-success')) {
    setDownloadButtonState('idle');
  }
  const goBtn = el('dlMenuStartBtn');
  if (goBtn) {
    goBtn.textContent = getFormattedDownloadSummary();
  }
}

function drawRoundedRectPath(ctx2d, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx2d.beginPath();
  ctx2d.moveTo(x + radius, y);
  ctx2d.arcTo(x + w, y, x + w, y + h, radius);
  ctx2d.arcTo(x + w, y + h, x, y + h, radius);
  ctx2d.arcTo(x, y + h, x, y, radius);
  ctx2d.arcTo(x, y, x + w, y, radius);
  ctx2d.closePath();
}

function drawVideoFrameWithSubtitles(ctx2d, videoEl, width, height, currentSec) {
  ctx2d.drawImage(videoEl, 0, 0, width, height);

  const activeFrag = (state.fragments || []).find(
    (f) => currentSec >= (Number(f.start) || 0) && currentSec <= (Number(f.end) || 0)
  );
  const rawText = activeFrag?.transcript?.trim();
  if (!rawText) return;

  const fontSize = Math.max(18, Math.round(height * 0.042));
  const lineHeight = Math.round(fontSize * 1.32);
  const maxTextWidth = width * 0.82;
  ctx2d.save();
  ctx2d.font = `600 ${fontSize}px "Sora", "Inter", system-ui, sans-serif`;
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';

  // Word-wrap subtitle text across lines cleanly
  const words = rawText.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx2d.measureText(candidate).width > maxTextWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  let maxLineW = 0;
  for (const l of lines) {
    const w = ctx2d.measureText(l).width;
    if (w > maxLineW) maxLineW = w;
  }

  const padX = Math.round(fontSize * 0.75);
  const padY = Math.round(fontSize * 0.42);
  const boxW = Math.min(width * 0.92, maxLineW + padX * 2);
  const boxH = lines.length * lineHeight + padY * 2;
  const bottomMargin = Math.max(20, Math.round(height * 0.055));
  const boxX = (width - boxW) / 2;
  const boxY = height - bottomMargin - boxH;

  drawRoundedRectPath(ctx2d, boxX, boxY, boxW, boxH, Math.round(fontSize * 0.4));
  ctx2d.fillStyle = 'rgba(10, 10, 16, 0.8)';
  ctx2d.fill();
  ctx2d.strokeStyle = 'rgba(178, 133, 245, 0.35)';
  ctx2d.lineWidth = Math.max(1, Math.round(fontSize * 0.06));
  ctx2d.stroke();

  ctx2d.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx2d.shadowBlur = Math.max(4, Math.round(fontSize * 0.25));
  ctx2d.fillStyle = '#FFFFFF';
  lines.forEach((l, idx) => {
    const y = boxY + padY + lineHeight * (idx + 0.5);
    ctx2d.fillText(l, width / 2, y);
  });
  ctx2d.restore();
}

async function encodeAudioBufferViaMediaRecorder(audioBuffer, mimeType, onProgress) {
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dest);

  const recorder = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const finished = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  const dur = Math.max(0.1, audioBuffer.duration || 1);
  const startWall = performance.now();
  const progressTimer = setInterval(() => {
    const elapsed = (performance.now() - startWall) / 1000;
    const pct = Math.min(96, Math.max(55, 55 + Math.floor((elapsed / dur) * 41)));
    if (onProgress) onProgress(pct);
  }, 80);

  recorder.start();
  src.start();

  await new Promise((resolve) => {
    src.onended = resolve;
    setTimeout(resolve, dur * 1000 + 350);
  });

  clearInterval(progressTimer);
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;
  return new Blob(chunks, { type: mimeType || 'audio/webm' });
}

async function executeFinalDubDownload() {
  const v = el('mainVideo');
  if (!v) return;
  if (!v.captureStream && !v.mozCaptureStream) {
    return showNotice("Export is not supported in this browser (captureStream unavailable).", "error");
  }
  if (!state.file && (!v.src || v.src === window.location.href)) {
    return showNotice("No video loaded to export.", "warning");
  }
  if (!state.duration || state.duration <= 0) {
    return showNotice("Video duration is invalid. Please wait for video to load.", "warning");
  }

  stopPlayback();
  closeDownloadOptionsMenu();

  const includeSubtitles = Boolean(exportConfig.includeSubtitles);
  const requestedFmt = exportConfig.videoFormat || 'webm';
  let resolvedFmt = requestedFmt;
  let mimeOpt = getSupportedVideoMime(resolvedFmt);
  if (!mimeOpt) {
    const fallbackKey = ['webm', 'mp4', 'mkv'].find((k) => Boolean(getSupportedVideoMime(k)));
    if (fallbackKey) {
      resolvedFmt = fallbackKey;
      mimeOpt = getSupportedVideoMime(fallbackKey);
      showNotice(
        `${requestedFmt.toUpperCase()} encoding is unavailable in this browser — exporting as ${resolvedFmt.toUpperCase()} instead.`,
        "info",
        3400
      );
    }
  }
  const fmtSpec = VIDEO_FORMAT_CANDIDATES[resolvedFmt] || VIDEO_FORMAT_CANDIDATES.webm;

  setDownloadButtonState('busy', includeSubtitles ? 'Rendering + Subtitles...' : 'Rendering Dub...');
  if (el('renderProgress')) el('renderProgress').classList.add('show');
  if (el('downloadLink')) el('downloadLink').classList.remove('show');
  if (el('renderStatus')) {
    el('renderStatus').textContent = includeSubtitles
      ? `Rendering ${fmtSpec.label} video with burned-in subtitles...`
      : `Rendering ${fmtSpec.label} final dub...`;
  }

  let renderStepper = null;
  let canvasDrawRaf = null;
  let canvasDrawTimer = null;
  try {
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();

    let videoTrackSourceStream = null;
    if (includeSubtitles) {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = Math.max(2, v.videoWidth || 1280);
      exportCanvas.height = Math.max(2, v.videoHeight || 720);
      const ctx2d = exportCanvas.getContext('2d');

      v.muted = true;
      v.currentTime = 0;
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 300); });
      drawVideoFrameWithSubtitles(ctx2d, v, exportCanvas.width, exportCanvas.height, 0);

      videoTrackSourceStream = exportCanvas.captureStream(30);
      const renderSubtitleFrame = () => {
        if (!v.paused && !v.ended) {
          drawVideoFrameWithSubtitles(ctx2d, v, exportCanvas.width, exportCanvas.height, v.currentTime || 0);
        }
        canvasDrawRaf = requestAnimationFrame(renderSubtitleFrame);
      };
      canvasDrawRaf = requestAnimationFrame(renderSubtitleFrame);
      canvasDrawTimer = setInterval(() => {
        drawVideoFrameWithSubtitles(ctx2d, v, exportCanvas.width, exportCanvas.height, v.currentTime || 0);
      }, 33);
    } else {
      videoTrackSourceStream = typeof v.captureStream === 'function'
        ? v.captureStream()
        : (typeof v.mozCaptureStream === 'function' ? v.mozCaptureStream() : null);
      v.muted = true;
      v.currentTime = 0;
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 300); });
    }

    if (!videoTrackSourceStream) {
      throw new Error("Video stream capture is not supported in this browser.");
    }

    const combined = new MediaStream([...videoTrackSourceStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(combined, mimeOpt ? { mimeType: mimeOpt } : undefined);

    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const finished = new Promise((r) => { recorder.onstop = r; });

    recorder.start();
    const t0 = ctx.currentTime + 0.1;
    const mixVol = parseInt(el('mixSlider')?.value || '65', 10) / 100;
    let usedFallback = false;

    if (state.backgroundBuffer) {
      const bgSrc = ctx.createBufferSource();
      bgSrc.buffer = state.backgroundBuffer;
      const bgGain = ctx.createGain();
      bgGain.gain.value = mixVol;
      bgSrc.connect(bgGain);
      bgGain.connect(dest);
      bgSrc.start(t0);
    } else if (state.masterBuffer) {
      usedFallback = true;
      const bgSrc = ctx.createBufferSource();
      bgSrc.buffer = state.masterBuffer;
      const bgGain = ctx.createGain();
      bgGain.gain.value = mixVol;
      bgSrc.connect(bgGain);
      bgGain.connect(dest);
      bgSrc.start(t0);
    }

    const latencySec = (Number(settings.get('micLatencyMs')) || 0) / 1000;
    const isAutoNorm = Boolean(settings.get('autoNormalize'));
    const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
    const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;

    const isParty = isPartyMode();
    const partyWinners = isParty ? (getPartyState()?.winners || {}) : null;

    state.fragments.forEach((f) => {
      const takes = state.takes[f.id] || {};
      let selectedWithTakes;
      if (isParty) {
        const winUid = partyWinners?.[f.id]?.uid;
        if (winUid && takes[winUid]?.buffer) {
          selectedWithTakes = [winUid];
        } else {
          const fallbackUid = Object.keys(takes).find((uid) => takes[uid]?.buffer);
          selectedWithTakes = fallbackUid ? [fallbackUid] : [];
        }
      } else {
        selectedWithTakes = (f.assigned || []).filter((uid) => takes[uid]?.buffer);
      }

      if (selectedWithTakes.length > 0) {
        selectedWithTakes.forEach((uid) => {
          const src = ctx.createBufferSource();
          let buf = takes[uid].buffer;
          if (isAutoNorm && buf) {
            const norm = normalizeAudioBuffer(ctx, buf, targetDb, { silenceThresholdDb: silenceFloor });
            buf = norm.buffer;
          }
          src.buffer = buf;
          src.connect(dest);
          const startTime = Math.max(0, t0 + f.start + latencySec);
          src.start(startTime);
        });
      } else {
        const seg = sliceMasterBuffer(f.start, f.end);
        if (seg) {
          const src = ctx.createBufferSource();
          src.buffer = seg;
          src.connect(dest);
          src.start(t0 + f.start);
        }
      }
    });

    await v.play().catch((e) => console.warn("Export playback warning:", e));
    const dur = state.duration || 1;
    renderStepper = createProgressStepper({
      fillEl: el('renderProgressFill'),
      initial: 0,
      minStepMs: 5,
      maxStepMs: 14,
    });
    const timer = setInterval(() => {
      const pct = Math.min(99, Math.floor((v.currentTime / dur) * 100));
      renderStepper.setTarget(pct);
    }, 50);

    await new Promise((r) => { v.onended = r; setTimeout(r, dur * 1000 + 1000); });
    clearInterval(timer);
    if (canvasDrawRaf) { cancelAnimationFrame(canvasDrawRaf); canvasDrawRaf = null; }
    if (canvasDrawTimer) { clearInterval(canvasDrawTimer); canvasDrawTimer = null; }
    await renderStepper.finish(100);
    if (recorder.state !== 'inactive') recorder.stop();
    await finished;

    const blob = new Blob(chunks, { type: mimeOpt || fmtSpec.mimeBase });
    if (lastFinalDownloadUrl) URL.revokeObjectURL(lastFinalDownloadUrl);
    lastFinalDownloadUrl = URL.createObjectURL(blob);

    const rawBase = (state.file?.name || state.videoSyncedName || 'loop-booth').replace(/\.[^/.]+$/, "");
    const safeBase = rawBase.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'loop-booth';
    const subFileSuffix = includeSubtitles ? '-subtitled' : '';
    const downloadFileName = `${safeBase}-dub${subFileSuffix}.${fmtSpec.ext}`;

    if (el('downloadLink')) {
      el('downloadLink').href = lastFinalDownloadUrl;
      el('downloadLink').download = downloadFileName;
      el('downloadLink').textContent = `Save .${fmtSpec.ext.toUpperCase()}`;
      el('downloadLink').classList.add('show');
      el('downloadLink').click();
    }

    setDownloadButtonState('success', 'Ready to Save!');
    setTimeout(() => {
      const btn = el('renderBtn');
      if (btn && btn.classList.contains('is-success')) {
        setDownloadButtonState('idle');
      }
    }, 7000);

    // Save completed dub snapshot into persistent Saved Dubs collection (skipped in Guest mode)
    if (!isGuestUser()) {
      let scoreSum = 0, scoredCount = 0;
      for (const fId in state.takes) {
        for (const uid in state.takes[fId]) {
          const s = state.takes[fId][uid]?.score;
          if (typeof s === 'number' && s > 0) { scoreSum += s; scoredCount++; }
        }
      }
      const avgScore = scoredCount > 0 ? Math.round(scoreSum / scoredCount) : null;

      saveCompletedDub({
        roomId: state.roomId,
        isSingleplayer: Boolean(state.isSingleplayer),
        isExported: true,
        title: (state.file?.name || state.videoSyncedName || 'Loop Booth Dub').replace(/\.[^/.]+$/, "") + " (Finished Dub)",
        videoName: state.file?.name || state.videoSyncedName || 'Finished Clip',
        videoSize: state.file?.size ? formatFileSize(state.file.size) : null,
        duration: state.duration || 0,
        collaborators: extractCollaborators(state.players, state.takes, state.isSingleplayer, state.uid),
        linesCount: state.fragments.length,
        completedLines: state.fragments.filter((f) => state.takes[f.id] && Object.keys(state.takes[f.id]).length > 0).length,
        takesCount: Object.values(state.takes).reduce((acc, t) => acc + Object.keys(t).length, 0),
        scoringMode: Boolean(state.scoringMode),
        avgScore,
        audioNormalized: Boolean(settings.get('autoNormalize')),
        exportUrl: el('downloadLink')?.href || lastFinalDownloadUrl,
        fragments: state.fragments,
      });
      persistCurrentSession();
    }

    const subNote = includeSubtitles ? ' with burned-in subtitles' : '';
    if (el('renderStatus')) {
      el('renderStatus').textContent = usedFallback
        ? `Done (${fmtSpec.label}${subNote}) - mono source, background includes original voice.`
        : `Done (${fmtSpec.label}${subNote}) - background audio carried through with voice removed.`;
    }
    setTimeout(() => { if (el('renderProgress')) el('renderProgress').classList.remove('show'); }, 1000);
    showNotice(`Final dub exported (${downloadFileName})!`, "success", 5000);
  } catch (err) {
    if (renderStepper) renderStepper.stop();
    if (canvasDrawRaf) cancelAnimationFrame(canvasDrawRaf);
    if (canvasDrawTimer) clearInterval(canvasDrawTimer);
    console.error("Export render error:", err);
    showNotice("Failed to export dub: " + (err?.message || "Render error"), "error");
    setDownloadButtonState('idle');
    if (el('renderProgress')) el('renderProgress').classList.remove('show');
  }
}

async function executeVocalsOnlyDownload() {
  if (!state.fragments || state.fragments.length === 0) {
    return showNotice("No timeline fragments loaded yet.", "warning");
  }

  const latencySec = (Number(settings.get('micLatencyMs')) || 0) / 1000;
  const isAutoNorm = Boolean(settings.get('autoNormalize'));
  const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
  const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;

  const takeEntries = [];
  const isParty = isPartyMode();
  const partyWinners = isParty ? (getPartyState()?.winners || {}) : null;

  for (const f of state.fragments) {
    const takes = state.takes[f.id] || {};
    let selectedUids;
    if (isParty) {
      const winUid = partyWinners?.[f.id]?.uid;
      if (winUid && takes[winUid]?.buffer) {
        selectedUids = [winUid];
      } else {
        const fallbackUid = Object.keys(takes).find((uid) => takes[uid]?.buffer);
        selectedUids = fallbackUid ? [fallbackUid] : [];
      }
    } else {
      const assignedWithTakes = (f.assigned || []).filter((uid) => takes[uid]?.buffer);
      selectedUids = assignedWithTakes.length > 0
        ? assignedWithTakes
        : Object.keys(takes).filter((uid) => takes[uid]?.buffer);
    }
    for (const uid of selectedUids) {
      const take = takes[uid];
      if (take?.buffer) {
        takeEntries.push({
          frag: f,
          uid,
          buffer: take.buffer,
          startTime: Math.max(0, (Number(f.start) || 0) + latencySec),
        });
      }
    }
  }

  if (takeEntries.length === 0) {
    return showNotice("No vocal takes recorded yet to export.", "warning");
  }

  stopPlayback();
  closeDownloadOptionsMenu();

  let targetAudioFmt = exportConfig.audioFormat || 'wav';
  let audioMime = getSupportedAudioMime(targetAudioFmt);
  if (!audioMime) {
    targetAudioFmt = 'wav';
    audioMime = 'audio/wav';
  }
  const fmtSpec = AUDIO_FORMAT_CANDIDATES[targetAudioFmt] || AUDIO_FORMAT_CANDIDATES.wav;

  setDownloadButtonState('busy', `Mixing Vocals (.${fmtSpec.ext})...`);

  const downloadVocalsLink = el('downloadVocalsLink');
  const renderStatus = el('renderStatus');
  const renderProgress = el('renderProgress');
  if (renderProgress) renderProgress.classList.add('show');
  if (downloadVocalsLink) downloadVocalsLink.classList.remove('show');
  if (renderStatus) renderStatus.textContent = `Mixing isolated vocal takes (${fmtSpec.label})...`;

  let vocalsStepper = null;
  try {
    vocalsStepper = createProgressStepper({
      fillEl: el('renderProgressFill'),
      initial: 0,
      minStepMs: 4,
      maxStepMs: 10,
    });
    vocalsStepper.setTarget(30);

    const liveCtx = ensureCtx();
    const sampleRate = state.masterBuffer?.sampleRate || takeEntries[0].buffer.sampleRate || liveCtx.sampleRate || 48000;
    let numChannels = 1;
    let maxEnd = Number(state.duration) || 0;

    for (const entry of takeEntries) {
      if (entry.buffer.numberOfChannels > 1) numChannels = 2;
      const end = entry.startTime + (entry.buffer.duration || 0);
      if (end > maxEnd) maxEnd = end;
    }
    if (maxEnd <= 0) {
      maxEnd = Math.max(...state.fragments.map((f) => Number(f.end) || 0), 1);
    }

    const totalSamples = Math.max(1, Math.ceil(maxEnd * sampleRate));
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) {
      throw new Error("Offline audio rendering is not supported in this browser.");
    }

    const offlineCtx = new OfflineCtx(numChannels, totalSamples, sampleRate);

    for (const entry of takeEntries) {
      let buf = entry.buffer;
      if (isAutoNorm && buf) {
        const norm = normalizeAudioBuffer(offlineCtx, buf, targetDb, { silenceThresholdDb: silenceFloor });
        buf = norm.buffer;
      }
      const src = offlineCtx.createBufferSource();
      src.buffer = buf;
      src.connect(offlineCtx.destination);
      src.start(entry.startTime);
    }

    vocalsStepper.setTarget(55);
    const renderedBuffer = await offlineCtx.startRendering();

    let outputBlob;
    if (targetAudioFmt === 'wav') {
      vocalsStepper.setTarget(90);
      outputBlob = audioBufferToWavBlob(renderedBuffer);
      if (!outputBlob) throw new Error("Failed to encode vocals WAV track.");
    } else {
      outputBlob = await encodeAudioBufferViaMediaRecorder(renderedBuffer, audioMime, (pct) => {
        vocalsStepper.setTarget(pct);
      });
    }

    await vocalsStepper.finish(100);

    const rawBase = (state.file?.name || state.videoSyncedName || 'loop-booth').replace(/\.[^/.]+$/, "");
    const safeBase = rawBase.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'loop-booth';
    const fileName = `${safeBase}-vocals-dub.${fmtSpec.ext}`;

    if (lastVocalsDownloadUrl) URL.revokeObjectURL(lastVocalsDownloadUrl);
    lastVocalsDownloadUrl = URL.createObjectURL(outputBlob);

    if (downloadVocalsLink) {
      downloadVocalsLink.href = lastVocalsDownloadUrl;
      downloadVocalsLink.download = fileName;
      downloadVocalsLink.textContent = `Save Vocals .${fmtSpec.ext.toUpperCase()}`;
      downloadVocalsLink.classList.add('show');
      downloadVocalsLink.click();
    } else {
      const a = document.createElement('a');
      a.href = lastVocalsDownloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    setDownloadButtonState('success', 'Vocals Ready!');
    setTimeout(() => {
      const btn = el('renderBtn');
      if (btn && btn.classList.contains('is-success')) {
        setDownloadButtonState('idle');
      }
    }, 7000);

    if (renderStatus) {
      renderStatus.textContent = `Done - ${takeEntries.length} vocal take${takeEntries.length === 1 ? '' : 's'} exported as ${fmtSpec.label} (no background audio).`;
    }
    setTimeout(() => { if (renderProgress) renderProgress.classList.remove('show'); }, 1000);
    showNotice(`Vocals-only final dub downloaded (${fileName}).`, "success", 5000);
  } catch (err) {
    if (vocalsStepper) vocalsStepper.stop();
    console.error("Vocals-only export error:", err);
    showNotice("Failed to export vocals: " + (err?.message || "Render error"), "error");
    setDownloadButtonState('idle');
    if (renderStatus) renderStatus.textContent = '';
    if (renderProgress) renderProgress.classList.remove('show');
  }
}

async function runConfiguredDownload() {
  if (exportConfig.mode === 'vocals') {
    return executeVocalsOnlyDownload();
  }
  return executeFinalDubDownload();
}

if (typeof document !== 'undefined') {
  if (el('renderBtn')) {
    el('renderBtn').onclick = runConfiguredDownload;
  }

  if (el('dlMenuStartBtn')) {
    el('dlMenuStartBtn').onclick = runConfiguredDownload;
  }

  if (el('downloadOptionsBtn') && el('downloadOptionsMenu')) {
    el('downloadOptionsBtn').onclick = (e) => {
      e.stopPropagation();
      const menu = el('downloadOptionsMenu');
      const isOpen = menu.style.display !== 'none';
      if (isOpen) {
        closeDownloadOptionsMenu();
      } else {
        syncDownloadOptionsUI();
        menu.style.display = 'flex';
        el('downloadOptionsBtn').setAttribute('aria-expanded', 'true');
      }
    };
  }

  document.querySelectorAll('[data-dl-mode]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const mode = btn.getAttribute('data-dl-mode');
      if (mode === 'final' || mode === 'vocals') {
        exportConfig.mode = mode;
        syncDownloadOptionsUI();
      }
    };
  });

  if (el('dlIncludeSubtitlesToggle')) {
    el('dlIncludeSubtitlesToggle').onchange = () => {
      exportConfig.includeSubtitles = Boolean(el('dlIncludeSubtitlesToggle').checked);
      syncDownloadOptionsUI();
    };
  }

  document.querySelectorAll('[data-dl-video-format]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const fmt = btn.getAttribute('data-dl-video-format');
      if (fmt && VIDEO_FORMAT_CANDIDATES[fmt]) {
        exportConfig.videoFormat = fmt;
        syncDownloadOptionsUI();
      }
    };
  });

  document.querySelectorAll('[data-dl-audio-format]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const fmt = btn.getAttribute('data-dl-audio-format');
      if (fmt && AUDIO_FORMAT_CANDIDATES[fmt]) {
        exportConfig.audioFormat = fmt;
        syncDownloadOptionsUI();
      }
    };
  });

  document.addEventListener('click', (e) => {
    const wrap = el('downloadSplitWrap');
    const menu = el('downloadOptionsMenu');
    if (menu && menu.style.display !== 'none' && wrap && !wrap.contains(e.target)) {
      closeDownloadOptionsMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDownloadOptionsMenu();
    }
  });

  syncDownloadOptionsUI();
}

// --- Real-Time Background Volume Slider ---
function getMixVolume() {
  const slider = el('mixSlider');
  const raw = slider ? Number(slider.value) : 65;
  if (!Number.isFinite(raw)) return 0.65;
  return Math.max(0, Math.min(1, raw / 100));
}

function syncMixSliderDisplay(rawValue) {
  const slider = el('mixSlider');
  const pct = Number.isFinite(Number(rawValue))
    ? Math.max(0, Math.min(100, Math.round(Number(rawValue))))
    : Math.max(0, Math.min(100, Math.round(getMixVolume() * 100)));
  if (slider && String(slider.value) !== String(pct)) {
    slider.value = String(pct);
  }
  if (el('mixSliderVal')) {
    el('mixSliderVal').textContent = `${pct}%`;
  }
}

function applyRealtimeBackgroundVolume() {
  const vol = getMixVolume();
  syncMixSliderDisplay(Math.round(vol * 100));
  if (typeof partyFinaleState !== 'undefined' && partyFinaleState?.bgGain) {
    try {
      const ctx = ensureCtx();
      partyFinaleState.bgGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.015);
    } catch (e) {
      partyFinaleState.bgGain.gain.value = vol;
    }
  }
  const v = el('mainVideo');
  if (!v || !state.pb) return;
  if (state.pb.remote || state.pb.mode === 'record') {
    v.muted = true;
    v.volume = 0;
    return;
  }
  if (state.pb.mode === 'review') {
    v.volume = vol;
    v.muted = vol <= 0;
  }
}

if (typeof document !== 'undefined') {
  const mixSliderEl = el('mixSlider');
  if (mixSliderEl) {
    mixSliderEl.addEventListener('input', () => applyRealtimeBackgroundVolume());
    mixSliderEl.addEventListener('change', () => applyRealtimeBackgroundVolume());
    syncMixSliderDisplay(mixSliderEl.value);
  }
}

// --- Side-by-Side Compare Takes Modal ---
let compareModalFragIndex = null;
let compareActivePlay = null;

function stopCompareAudition() {
  if (compareActivePlay?.source) {
    try { compareActivePlay.source.stop(); } catch (e) {}
    try { compareActivePlay.source.disconnect(); } catch (e) {}
  }
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.compare-take-card.is-playing').forEach((card) => card.classList.remove('is-playing'));
    document.querySelectorAll('.compare-play-btn.is-playing').forEach((btn) => {
      btn.classList.remove('is-playing');
      btn.textContent = 'Play Take';
    });
  }
  compareActivePlay = null;
}

function playCompareTake(uid, buffer, cardEl, btnEl) {
  const wasSame = compareActivePlay?.uid === uid;
  stopCompareAudition();
  if (wasSame) return;

  if (!buffer) {
    showNotice('Audio buffer for this take is not loaded locally.', 'warning');
    return;
  }
  if (state.isPlaying && !state.paused) {
    pausePlayback();
  }

  const ctx = ensureCtx();
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  if (cardEl) cardEl.classList.add('is-playing');
  if (btnEl) {
    btnEl.classList.add('is-playing');
    btnEl.textContent = 'Stop';
  }
  compareActivePlay = { source: src, uid, cardEl, btnEl };
  src.onended = () => {
    if (compareActivePlay && compareActivePlay.source === src) {
      stopCompareAudition();
    }
  };
  src.start(0);
}

function computeWaveformPeaks(take, bucketCount, durationHint = 0) {
  const safeBuckets = Math.max(24, bucketCount | 0);
  if (take?.buffer && typeof take.buffer.getChannelData === 'function' && take.buffer.length > 0) {
    const buf = take.buffer;
    const channels = Math.max(1, buf.numberOfChannels || 1);
    const totalSamples = buf.length;
    const chData = [];
    for (let c = 0; c < channels; c++) chData.push(buf.getChannelData(c));

    const buckets = new Array(safeBuckets);
    let totalSumSq = 0;
    let totalCountedSamples = 0;
    let loudestBucketIndex = 0;
    let loudestBucketAbs = 0;

    for (let b = 0; b < safeBuckets; b++) {
      const start = Math.floor((b * totalSamples) / safeBuckets);
      const end = Math.max(start + 1, Math.floor(((b + 1) * totalSamples) / safeBuckets));
      let minVal = 0;
      let maxVal = 0;
      let bSumSq = 0;
      let count = 0;
      const step = Math.max(1, Math.floor((end - start) / 48));

      for (let s = start; s < end && s < totalSamples; s += step) {
        let sample = 0;
        for (let c = 0; c < channels; c++) sample += chData[c][s];
        sample /= channels;
        if (sample < minVal) minVal = sample;
        if (sample > maxVal) maxVal = sample;
        bSumSq += sample * sample;
        totalSumSq += sample * sample;
        count++;
        totalCountedSamples++;
      }

      const rms = count > 0 ? Math.sqrt(bSumSq / count) : 0;
      const absPeak = Math.max(Math.abs(minVal), Math.abs(maxVal));
      if (absPeak > loudestBucketAbs) {
        loudestBucketAbs = absPeak;
        loudestBucketIndex = b;
      }
      buckets[b] = { min: minVal, max: maxVal, rms };
    }

    const peakLinear = calculatePeak(buf);
    const overallRms = Math.sqrt(totalSumSq / Math.max(1, totalCountedSamples));
    return {
      buckets,
      loudestBucketIndex,
      peakLinear,
      peakDb: linearToDb(peakLinear),
      rmsDb: linearToDb(overallRms),
      duration: buf.duration || durationHint || 0,
      hasBuffer: true,
    };
  }

  const trace = Array.isArray(take?.trace) ? take.trace : [];
  const buckets = new Array(safeBuckets);
  let peakLinear = 0;
  let sumSq = 0;
  let loudestBucketIndex = 0;
  let loudestBucketAbs = 0;

  for (let b = 0; b < safeBuckets; b++) {
    const idx = trace.length > 0 ? Math.min(trace.length - 1, Math.floor((b / safeBuckets) * trace.length)) : 0;
    const amp = trace.length > 0 ? Math.max(0, Math.min(1, Number(trace[idx]) || 0)) : 0;
    if (amp > peakLinear) peakLinear = amp;
    if (amp > loudestBucketAbs) {
      loudestBucketAbs = amp;
      loudestBucketIndex = b;
    }
    sumSq += amp * amp;
    buckets[b] = { min: -amp, max: amp, rms: amp * 0.65 };
  }

  const overallRms = Math.sqrt(sumSq / safeBuckets);
  return {
    buckets,
    loudestBucketIndex,
    peakLinear,
    peakDb: linearToDb(peakLinear),
    rmsDb: linearToDb(overallRms),
    duration: durationHint || 0,
    hasBuffer: false,
  };
}

function drawCompareTakeWaveformCanvas(canvas, take, color, durationHint = 0) {
  if (!canvas) return null;
  const wrap = canvas.parentElement;
  const rect = (wrap || canvas).getBoundingClientRect();
  const width = Math.max(200, Math.round(rect.width) || 340);
  const height = Math.max(84, Math.round(rect.height) || 118);
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.save();
  ctx.scale(dpr, dpr);

  // Dark studio backdrop
  ctx.fillStyle = '#0D0A08';
  ctx.fillRect(0, 0, width, height);

  const midY = height / 2;
  const maxHalfH = Math.max(10, midY - 8);

  // -3 dBFS (~0.708) & -6 dBFS (~0.501) threshold guides
  const db3YTop = midY - maxHalfH * 0.708;
  const db3YBot = midY + maxHalfH * 0.708;
  const db6YTop = midY - maxHalfH * 0.501;
  const db6YBot = midY + maxHalfH * 0.501;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  [db3YTop, db3YBot, db6YTop, db6YBot].forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // Center zero-crossing axis
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();

  const bucketCount = Math.max(48, Math.min(220, Math.floor(width / 2.5)));
  const stats = computeWaveformPeaks(take, bucketCount, durationHint);
  const colWidth = width / stats.buckets.length;
  const barWidth = Math.max(1.2, colWidth - 0.7);
  const barColor = color || '#B285F5';

  // Peak envelope bars
  const grad = ctx.createLinearGradient(0, midY - maxHalfH, 0, midY + maxHalfH);
  grad.addColorStop(0, barColor);
  grad.addColorStop(0.5, '#FFFFFF');
  grad.addColorStop(1, barColor);

  ctx.fillStyle = barColor;
  ctx.globalAlpha = 0.42;
  stats.buckets.forEach((b, idx) => {
    const x = idx * colWidth;
    const topY = midY - Math.max(0.02, Math.abs(b.max)) * maxHalfH;
    const botY = midY + Math.max(0.02, Math.abs(b.min)) * maxHalfH;
    const barH = Math.max(1.5, botY - topY);
    ctx.fillRect(x, topY, barWidth, barH);
  });

  // Brighter inner RMS / core peak trace
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.88;
  stats.buckets.forEach((b, idx) => {
    const x = idx * colWidth;
    const rmsAmp = Math.max(0.015, b.rms * 1.15);
    const barH = Math.max(1.5, rmsAmp * maxHalfH * 2);
    ctx.fillRect(x, midY - barH / 2, barWidth, barH);
  });

  // Loudest peak callout tick
  if (stats.peakLinear > 0.01) {
    const px = stats.loudestBucketIndex * colWidth + barWidth / 2;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = stats.peakDb > -0.5 ? '#FF6E63' : '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 4);
    ctx.lineTo(px, height - 4);
    ctx.stroke();
  }

  // Subtle dB labels
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#D5D0DC';
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText('-3dB', 5, Math.max(10, db3YTop - 2));
  ctx.fillText('-6dB', 5, Math.max(18, db6YTop - 2));

  ctx.restore();
  return stats;
}

function renderCompareTakesModal() {
  if (compareModalFragIndex === null || !state.fragments.length) return;
  const idx = Math.max(0, Math.min(state.fragments.length - 1, compareModalFragIndex));
  compareModalFragIndex = idx;
  const f = state.fragments[idx];
  const fragDur = Math.max(0.05, f.end - f.start);

  if (el('compareModalTitle')) {
    el('compareModalTitle').textContent = `Compare Takes — Line ${idx + 1} of ${state.fragments.length}`;
  }
  const transcriptText = state.transcripts[f.id] || state.transcripts[String(f.id)] || '';
  if (el('compareModalSub')) {
    const timeText = `${f.start.toFixed(1)}s – ${f.end.toFixed(1)}s (${fragDur.toFixed(2)}s)`;
    el('compareModalSub').textContent = transcriptText ? `${timeText} · "${transcriptText}"` : timeText;
  }

  if (el('comparePrevLineBtn')) el('comparePrevLineBtn').disabled = idx <= 0;
  if (el('compareNextLineBtn')) el('compareNextLineBtn').disabled = idx >= state.fragments.length - 1;

  const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
  const takesObj = state.takes[f.id] || {};
  const assignedSet = new Set(Array.isArray(f.assigned) ? f.assigned : []);
  const orderedUids = [];
  (f.assigned || []).forEach((uid) => {
    if (takesObj[uid] && (takesObj[uid].buffer || (Array.isArray(takesObj[uid].trace) && takesObj[uid].trace.length > 0))) {
      orderedUids.push(uid);
    }
  });
  Object.keys(takesObj).forEach((uid) => {
    if (!orderedUids.includes(uid) && takesObj[uid] && (takesObj[uid].buffer || (Array.isArray(takesObj[uid].trace) && takesObj[uid].trace.length > 0))) {
      orderedUids.push(uid);
    }
  });

  const summaryBar = el('compareSummaryBar');
  const grid = el('compareTakesGrid');
  if (!grid || !summaryBar) return;

  stopCompareAudition();
  grid.innerHTML = '';

  if (orderedUids.length === 0) {
    summaryBar.innerHTML = `<div class="compare-summary-meta"><span>No recorded takes yet on Line ${idx + 1}</span></div><span class="compare-summary-pill">0 Takes</span>`;
    grid.innerHTML = `<div class="compare-empty-state">No takes have been recorded for Line ${idx + 1} yet. Record a take or use Prev / Next to inspect another line.</div>`;
    return;
  }

  const pendingDraws = [];
  let loudestEntry = null;

  orderedUids.forEach((uid) => {
    const take = takesObj[uid];
    const p = roomPlayers.find((x) => x.id === uid);
    const pName = p ? p.name : (uid === state.uid ? (state.me?.name || 'You') : 'Player');
    const pColor = p ? p.color : '#B285F5';
    const isUnassigned = assignedSet.size > 0 && !assignedSet.has(uid);
    const quickStats = computeWaveformPeaks(take, 96, fragDur);

    if (!loudestEntry || quickStats.peakLinear > loudestEntry.peakLinear) {
      loudestEntry = { name: pName, peakDb: quickStats.peakDb, peakLinear: quickStats.peakLinear };
    }

    const card = document.createElement('div');
    card.className = 'compare-take-card';

    const badges = [];
    if (take.normalized) badges.push(`<span class="compare-take-badge">Normalized</span>`);
    if (state.scoringMode && typeof take.score === 'number' && take.score > 0) {
      badges.push(`<span class="compare-take-badge">★ ${take.score}%</span>`);
    }
    if (isUnassigned) badges.push(`<span class="compare-take-badge">Previous</span>`);

    const peakLabel = Number.isFinite(quickStats.peakDb) && quickStats.peakDb > -90
      ? `${quickStats.peakDb.toFixed(1)} dBFS`
      : '-∞ dBFS';
    const rmsLabel = Number.isFinite(quickStats.rmsDb) && quickStats.rmsDb > -90
      ? `${quickStats.rmsDb.toFixed(1)} dBFS`
      : '-∞ dBFS';
    const durLabel = `${(quickStats.duration || fragDur).toFixed(2)}s`;

    card.innerHTML = `
      <div class="compare-take-head">
        <div class="compare-take-player">
          <span class="compare-take-dot" style="background:${escapeHtml(pColor)}; box-shadow:0 0 8px ${escapeHtml(pColor)};"></span>
          <span class="compare-take-name">${escapeHtml(pName)}</span>
          ${badges.join('')}
        </div>
        <button type="button" class="btn compare-play-btn" ${take.buffer ? '' : 'disabled title="Full audio buffer not available locally"'}>
          ${take.buffer ? 'Play Take' : 'Preview Only'}
        </button>
      </div>
      <div class="compare-take-canvas-wrap">
        <canvas class="compare-take-canvas" aria-label="Waveform peaks for ${escapeHtml(pName)}"></canvas>
      </div>
      <div class="compare-take-metrics">
        <span class="compare-metric-chip">Peak <strong>${peakLabel}</strong></span>
        <span class="compare-metric-chip">RMS <strong>${rmsLabel}</strong></span>
        <span class="compare-metric-chip">Length <strong>${durLabel}</strong></span>
      </div>
    `;

    const playBtn = card.querySelector('.compare-play-btn');
    if (playBtn && take.buffer) {
      playBtn.onclick = () => playCompareTake(uid, take.buffer, card, playBtn);
    }

    const canvas = card.querySelector('.compare-take-canvas');
    grid.appendChild(card);
    pendingDraws.push({ canvas, take, pColor });
  });

  const loudestDbText = loudestEntry && Number.isFinite(loudestEntry.peakDb) && loudestEntry.peakDb > -90
    ? `${loudestEntry.name} (${loudestEntry.peakDb.toFixed(1)} dBFS)`
    : 'Silence';

  summaryBar.innerHTML = `
    <div class="compare-summary-meta">
      <span>Comparing <strong>${orderedUids.length}</strong> ${orderedUids.length === 1 ? 'take' : 'takes'} side-by-side</span>
      <span>Loudest Peak: <strong>${escapeHtml(loudestDbText)}</strong></span>
    </div>
    <span class="compare-summary-pill">${orderedUids.length} ${orderedUids.length === 1 ? 'Take' : 'Takes'}</span>
  `;

  requestAnimationFrame(() => {
    pendingDraws.forEach(({ canvas, take, pColor }) => {
      drawCompareTakeWaveformCanvas(canvas, take, pColor, fragDur);
    });
  });
}

function openCompareTakesModal(fragIndex = state.currentIndex) {
  if (!state.fragments || state.fragments.length === 0) return;
  stopCompareAudition();
  compareModalFragIndex = Math.max(0, Math.min(state.fragments.length - 1, Number(fragIndex) || 0));
  const modal = el('compareTakesModal');
  if (!modal) return;
  modal.classList.add('active');
  renderCompareTakesModal();
}

function closeCompareTakesModal() {
  stopCompareAudition();
  const modal = el('compareTakesModal');
  if (modal) modal.classList.remove('active');
  compareModalFragIndex = null;
}

if (typeof document !== 'undefined') {
  if (el('compareCloseBtn')) el('compareCloseBtn').onclick = closeCompareTakesModal;
  if (el('compareDoneBtn')) el('compareDoneBtn').onclick = closeCompareTakesModal;
  if (el('compareTakesModal')) {
    el('compareTakesModal').addEventListener('click', (e) => {
      if (e.target === el('compareTakesModal')) closeCompareTakesModal();
    });
  }
  if (el('comparePrevLineBtn')) {
    el('comparePrevLineBtn').onclick = () => {
      if (compareModalFragIndex !== null && compareModalFragIndex > 0) {
        compareModalFragIndex -= 1;
        renderCompareTakesModal();
      }
    };
  }
  if (el('compareNextLineBtn')) {
    el('compareNextLineBtn').onclick = () => {
      if (compareModalFragIndex !== null && compareModalFragIndex < state.fragments.length - 1) {
        compareModalFragIndex += 1;
        renderCompareTakesModal();
      }
    };
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('unhandledrejection', (event) => {
    console.error("Unhandled promise rejection:", event.reason);
    const reason = event.reason;
    const msg = reason?.message || (typeof reason === 'string' ? reason : null);
    const name = reason?.name || '';
    if (name === 'AbortError' || (msg && (
      msg.includes('interrupted by a call to pause()') ||
      msg.includes('play() request was interrupted') ||
      msg.includes('The play() request was aborted') ||
      msg.includes('AbortError') ||
      msg.includes('WebSocket') ||
      msg.includes('network error')
    ))) {
      return;
    }
    if (msg) {
      showNotice(msg.length > 95 ? msg.slice(0, 95) + '...' : msg, 'error');
    }
  });

  let resizeRedrawTimer = null;
  window.addEventListener('resize', () => {
    if (resizeRedrawTimer) clearTimeout(resizeRedrawTimer);
    resizeRedrawTimer = setTimeout(() => {
      if (el('studioScreen')?.classList.contains('active')) {
        renderMasterCanvas();
        if (state.fragments[state.currentIndex]) {
          drawWave(state.fragments[state.currentIndex]);
        }
      }
      if (el('compareTakesModal')?.classList.contains('active')) {
        renderCompareTakesModal();
      }
    }, 90);
  });
}

// --- Multiplayer Quick-Action Emote Menu & Floating Reactions ---
const MULTIPLAYER_EMOTES = [
  { id: 'thumbsup', emoji: '👍', label: 'Nice' },
  { id: 'poop', emoji: '💩', label: 'Poop' },
  { id: 'clap', emoji: '👏', label: 'Clap' },
  { id: 'laugh', emoji: '😂', label: 'Haha' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'wow', emoji: '😮', label: 'Whoa' },
  { id: 'skull', emoji: '💀', label: 'Dead' },
  { id: 'heart', emoji: '❤️', label: 'Love' },
];

const EMOTE_COOLDOWN_MS = 2000;
let lastEmoteSentAt = 0;
let emoteCoolingTimer = null;

function setEmoteCooldownVisual(isCooling) {
  if (typeof document === 'undefined') return;
  ['studioEmoteGrid', 'lobbyEmoteGrid', 'partyFinaleEmoteBar'].forEach((id) => {
    const node = el(id);
    if (node) node.classList.toggle('is-cooling', Boolean(isCooling));
  });
}

function syncEmoteMenuVisibility() {
  const showMultiplayer = !isSoloSession() && Boolean(state.roomId);
  if (el('studioEmoteWrap')) {
    el('studioEmoteWrap').style.display = showMultiplayer ? 'inline-flex' : 'none';
  }
  if (el('lobbyEmoteWrap')) {
    el('lobbyEmoteWrap').style.display = showMultiplayer ? 'inline-flex' : 'none';
  }
  if (!showMultiplayer) {
    closeEmotePopovers();
  }
}

function closeEmotePopovers() {
  [
    ['studioEmotePopover', 'studioEmoteBtn'],
    ['lobbyEmotePopover', 'lobbyEmoteBtn'],
  ].forEach(([popId, btnId]) => {
    const pop = el(popId);
    const btn = el(btnId);
    if (pop) pop.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function toggleEmotePopover(popId, btnId) {
  const pop = el(popId);
  const btn = el(btnId);
  if (!pop || !btn) return;
  const isOpen = pop.style.display !== 'none';
  closeEmotePopovers();
  if (!isOpen) {
    pop.style.display = 'block';
    btn.setAttribute('aria-expanded', 'true');
  }
}

function spawnFloatingEmote({ emoji = '👍', label = '', playerName = 'Player', playerColor = '#B285F5' } = {}) {
  const layer = el('emoteFloatLayer');
  if (!layer) return;

  // Keep DOM lightweight during lively reaction bursts
  while (layer.children.length >= 24) {
    layer.firstElementChild?.remove();
  }

  const item = document.createElement('div');
  item.className = 'floating-emote';
  const xPercent = (14 + Math.random() * 72).toFixed(1);
  const driftA = ((Math.random() - 0.5) * 28).toFixed(0);
  const driftB = ((Math.random() - 0.5) * 42).toFixed(0);
  const driftC = ((Math.random() - 0.5) * 52).toFixed(0);
  const durationSec = (2.3 + Math.random() * 0.6).toFixed(2);

  item.style.setProperty('--emote-x', `${xPercent}%`);
  item.style.setProperty('--emote-drift-a', `${driftA}px`);
  item.style.setProperty('--emote-drift-b', `${driftB}px`);
  item.style.setProperty('--emote-drift-c', `${driftC}px`);
  item.style.setProperty('--emote-dur', `${durationSec}s`);
  item.style.setProperty('--emote-color', playerColor || '#B285F5');
  if (label) item.setAttribute('title', `${playerName}: ${label}`);

  const emojiSpan = document.createElement('span');
  emojiSpan.className = 'floating-emote-emoji';
  emojiSpan.textContent = emoji;

  const senderSpan = document.createElement('span');
  senderSpan.className = 'floating-emote-sender';
  senderSpan.textContent = playerName || 'Player';

  item.appendChild(emojiSpan);
  item.appendChild(senderSpan);
  layer.appendChild(item);

  const ttlMs = Math.ceil(parseFloat(durationSec) * 1000) + 120;
  setTimeout(() => {
    item.remove();
  }, ttlMs);
}

function sendMultiplayerEmote(emote) {
  if (!emote || isSoloSession() || !state.roomId) return;
  const now = Date.now();
  if (now - lastEmoteSentAt < EMOTE_COOLDOWN_MS) {
    showNotice('Cooldown', 'warning', 1200);
    return;
  }
  lastEmoteSentAt = now;
  setEmoteCooldownVisual(true);
  if (emoteCoolingTimer) clearTimeout(emoteCoolingTimer);
  emoteCoolingTimer = setTimeout(() => {
    emoteCoolingTimer = null;
    setEmoteCooldownVisual(false);
  }, EMOTE_COOLDOWN_MS);

  const senderName = state.me?.name || 'Player';
  const senderColor = state.me?.color || PLAYER_COLORS[0];

  spawnFloatingEmote({
    emoji: emote.emoji,
    label: emote.label,
    playerName: senderName,
    playerColor: senderColor,
  });

  sendPlaybackEvent({
    action: 'emote',
    emoteId: emote.id,
    emoji: emote.emoji,
    label: emote.label,
    playerColor: senderColor,
  });
}

function renderEmoteGrid(gridEl) {
  if (!gridEl) return;
  gridEl.innerHTML = '';
  MULTIPLAYER_EMOTES.forEach((emote) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emote-item-btn';
    btn.setAttribute('role', 'menuitem');
    btn.title = `Send ${emote.label} reaction`;
    btn.innerHTML = `<span class="emote-item-emoji">${emote.emoji}</span><span class="emote-item-label">${escapeHtml(emote.label)}</span>`;
    btn.onclick = (e) => {
      e.stopPropagation();
      sendMultiplayerEmote(emote);
    };
    gridEl.appendChild(btn);
  });
}

if (typeof document !== 'undefined') {
  renderEmoteGrid(el('studioEmoteGrid'));
  renderEmoteGrid(el('lobbyEmoteGrid'));
  syncEmoteMenuVisibility();

  if (el('studioEmoteBtn')) {
    el('studioEmoteBtn').onclick = (e) => {
      e.stopPropagation();
      toggleEmotePopover('studioEmotePopover', 'studioEmoteBtn');
    };
  }
  if (el('lobbyEmoteBtn')) {
    el('lobbyEmoteBtn').onclick = (e) => {
      e.stopPropagation();
      toggleEmotePopover('lobbyEmotePopover', 'lobbyEmoteBtn');
    };
  }

  document.addEventListener('click', (e) => {
    const studioWrap = el('studioEmoteWrap');
    const lobbyWrap = el('lobbyEmoteWrap');
    const inStudio = studioWrap && studioWrap.contains(e.target);
    const inLobby = lobbyWrap && lobbyWrap.contains(e.target);
    if (!inStudio && !inLobby) {
      closeEmotePopovers();
    }
  });
}

// --- Guest & Account Login Preparation ---
let authFormIntent = 'signin';

function syncAuthUI() {
  const guest = isGuestUser();
  const display = getAuthDisplayName();
  if (el('accountBtnSetupLabel')) {
    el('accountBtnSetupLabel').textContent = guest ? 'Guest · Sign In' : display;
  }
  if (el('setupAccountStatusText')) {
    el('setupAccountStatusText').textContent = guest ? 'Playing as Guest' : `Signed in as ${display}`;
  }
  if (el('authStatusTitle')) {
    el('authStatusTitle').textContent = guest ? 'Playing as Guest' : `Signed in as ${display}`;
  }
  if (el('authStatusDesc')) {
    el('authStatusDesc').textContent = guest
      ? 'Accounts are coming soon. In guest mode you can join rooms, record, react, and download exports, while Saved Dubs & Recent Sessions are disabled.'
      : 'Your account history and saved sessions are active.';
  }
  if (el('diagAccountMode')) {
    el('diagAccountMode').textContent = guest ? 'Guest (Temporary)' : display;
  }
}

function setAuthFormIntent(intent = 'signin') {
  authFormIntent = intent === 'register' ? 'register' : 'signin';
  if (el('authTabSignIn')) {
    const active = authFormIntent === 'signin';
    el('authTabSignIn').classList.toggle('is-active', active);
    el('authTabSignIn').setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (el('authTabRegister')) {
    const active = authFormIntent === 'register';
    el('authTabRegister').classList.toggle('is-active', active);
    el('authTabRegister').setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (el('authSubmitBtn')) {
    el('authSubmitBtn').textContent = authFormIntent === 'register'
      ? 'Create Account (Coming Soon)'
      : 'Sign In (Coming Soon)';
  }
  if (el('authFormMessage')) {
    el('authFormMessage').style.display = 'none';
    el('authFormMessage').textContent = '';
  }
}

function openAuthModal() {
  syncAuthUI();
  setAuthFormIntent('signin');
  if (el('authModal')) {
    el('authModal').classList.add('active');
  }
}

function closeAuthModal() {
  if (el('authModal')) {
    el('authModal').classList.remove('active');
  }
}

if (typeof document !== 'undefined') {
  syncAuthUI();

  if (el('accountBtnSetup')) el('accountBtnSetup').onclick = openAuthModal;
  if (el('setupSignInLink')) el('setupSignInLink').onclick = openAuthModal;
  if (el('authCloseBtn')) el('authCloseBtn').onclick = closeAuthModal;
  if (el('authModal')) {
    el('authModal').addEventListener('click', (e) => {
      if (e.target === el('authModal')) closeAuthModal();
    });
  }
  if (el('authTabSignIn')) el('authTabSignIn').onclick = () => setAuthFormIntent('signin');
  if (el('authTabRegister')) el('authTabRegister').onclick = () => setAuthFormIntent('register');

  if (el('authForm')) {
    el('authForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = el('authEmailInput')?.value || '';
      const password = el('authPasswordInput')?.value || '';
      const result = submitPreparedLogin({ email, password, intent: authFormIntent });
      if (el('authFormMessage')) {
        el('authFormMessage').textContent = result.message;
        el('authFormMessage').style.display = 'block';
      }
      showNotice(result.message, 'info', 3400);
    });
  }

  if (el('playAsGuestBtn')) {
    el('playAsGuestBtn').onclick = () => {
      enterGuestMode();
      syncAuthUI();
      closeAuthModal();
      if (el('savedDubsScreen')?.classList.contains('active')) {
        renderSavedDubsScreen();
      }
      showNotice('Playing as Guest. Saved Dubs & Recent Sessions are unavailable in guest mode.', 'info', 3400);
    };
  }
}

// --- Party Showdown (4-8 Player Jackbox-Style Gamemode) ---
let partyAuditionPlay = null;
let lastPartyRoundSerial = 0;
let lastPartyPhase = null;
let lastPartyWinnerKey = '';
let lastFinaleSeq = 0;
let partyFinaleActiveTab = 'watch';

let partyFinaleState = {
  playing: false,
  seq: 0,
  rafId: null,
  sources: [],
  bgGain: null,
};

function resetPartyTrackingState() {
  lastPartyRoundSerial = 0;
  lastPartyPhase = null;
  lastPartyWinnerKey = '';
  lastFinaleSeq = 0;
  partyFinaleActiveTab = 'watch';
  stopPartyAudition();
  stopPartyFinalePlayback();
}

function syncPartyModeClasses() {
  if (typeof document === 'undefined') return;
  const partyActive = isPartyMode() && el('studioScreen')?.classList.contains('active');
  const party = getPartyState();
  const isFinale = partyActive && party?.phase === 'finale';
  document.body.classList.toggle('party-mode', Boolean(partyActive));
  document.body.classList.toggle('party-host', Boolean(partyActive && state.isHost));
  document.body.classList.toggle('party-guest', Boolean(partyActive && !state.isHost));
  document.body.classList.toggle('party-finale-phase', Boolean(isFinale));
  document.body.classList.toggle('host-edit-mode', Boolean(state.isHost && state.editMode));
}

function stopPartyAudition() {
  if (partyAuditionPlay?.source) {
    try { partyAuditionPlay.source.stop(); } catch (e) {}
    try { partyAuditionPlay.source.disconnect(); } catch (e) {}
  }
  const v = el('mainVideo');
  if (partyAuditionPlay?.withVideo && v && !partyFinaleState.playing && !state.isPlaying) {
    try { v.pause(); } catch (e) {}
  }
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.party-candidate-card.is-playing').forEach((card) => card.classList.remove('is-playing'));
    document.querySelectorAll('.party-cand-play-btn.is-playing').forEach((btn) => {
      btn.classList.remove('is-playing');
      btn.textContent = 'Play Take';
    });
    if (el('partyWinnerReplayBtn')) {
      el('partyWinnerReplayBtn').classList.remove('is-playing');
      el('partyWinnerReplayBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Replay Take</span>`;
    }
  }
  partyAuditionPlay = null;
}

async function auditionPartyCandidate(uid, frag, cardEl = null, btnEl = null, withVideo = true) {
  if (!frag || !uid) return;
  const wasSame = partyAuditionPlay?.uid === uid && partyAuditionPlay?.fragId === frag.id;
  stopPartyAudition();
  if (wasSame) return;

  const take = state.takes[frag.id]?.[uid];
  if (!take?.buffer) {
    showNotice('Audio take is still syncing for this player.', 'warning', 2200);
    return;
  }

  if (state.isPlaying) {
    stopPlayback(true);
  }

  const ctx = ensureCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  const v = el('mainVideo');
  let playingWithVideo = false;
  if (withVideo && v && Number.isFinite(frag.start)) {
    try {
      v.muted = true;
      v.currentTime = frag.start;
      v.playbackRate = 1;
      v.play().catch(() => {});
      playingWithVideo = true;
    } catch (e) {}
  }

  const src = ctx.createBufferSource();
  src.buffer = take.buffer;
  src.connect(ctx.destination);

  if (cardEl) cardEl.classList.add('is-playing');
  if (btnEl) {
    btnEl.classList.add('is-playing');
    if (btnEl.id === 'partyWinnerReplayBtn') {
      btnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><rect x="6" y="6" width="12" height="12"></rect></svg><span>Stop</span>`;
    } else {
      btnEl.textContent = 'Stop';
    }
  }

  const lineDurMs = Math.max(250, Math.round((frag.end - frag.start) * 1000) + 180);
  const stopTimer = playingWithVideo ? setTimeout(() => {
    if (partyAuditionPlay && partyAuditionPlay.source === src) {
      stopPartyAudition();
    }
  }, lineDurMs) : null;

  partyAuditionPlay = { source: src, uid, fragId: frag.id, cardEl, btnEl, withVideo: playingWithVideo, stopTimer };
  src.onended = () => {
    if (stopTimer) clearTimeout(stopTimer);
    if (partyAuditionPlay && partyAuditionPlay.source === src) {
      stopPartyAudition();
    }
  };
  src.start(0);
}

function auditionSpotlightFromEvent(candidateUid, fragIndex) {
  if (!isPartyMode()) return;
  const idx = typeof fragIndex === 'number' ? fragIndex : (getPartyState()?.fragmentIndex ?? state.currentIndex);
  const frag = state.fragments[idx];
  if (!frag || !candidateUid) return;
  const players = state.roomData?.players || [];
  const candPlayer = players.find((p) => p.id === candidateUid);
  showNotice(`Host spotlighted ${candPlayer?.name || 'a player'}'s take!`, 'info', 2000);
  if (state.takes[frag.id]?.[candidateUid]?.buffer) {
    auditionPartyCandidate(candidateUid, frag, null, null, true);
  }
  syncPartyUI();
}

function closePartyRedoMenu() {
  if (el('partyRedoMenu')) el('partyRedoMenu').style.display = 'none';
  if (el('partyRedoAnyBtn')) el('partyRedoAnyBtn').setAttribute('aria-expanded', 'false');
}

function renderPartyRedoMenu(party) {
  const menu = el('partyRedoMenu');
  if (!menu) return;
  menu.innerHTML = '';
  const winners = party?.winners || {};
  state.fragments.forEach((f, idx) => {
    const win = winners[f.id];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'party-redo-item';
    item.innerHTML = `
      <span>Redo Line ${idx + 1}</span>
      <span class="party-redo-item-meta">${win ? `★ ${escapeHtml(win.playerName || 'Winner')}` : (idx === party?.fragmentIndex ? 'Active' : `${f.start.toFixed(1)}s`)}</span>
    `;
    item.onclick = (e) => {
      e.stopPropagation();
      closePartyRedoMenu();
      triggerHostRedoFragment(idx, f.id);
    };
    menu.appendChild(item);
  });
}

async function triggerHostRedoFragment(fragmentIndex, fragId) {
  if (!isPartyHost() || !state.roomId) return;
  try {
    if (state.takes[fragId]) {
      delete state.takes[fragId];
    }
    stopPartyAudition();
    stopPartyFinalePlayback();
    stopPlayback(true);
    await multiplayer.api.partyAction(state.roomId, {
      action: 'redo-fragment',
      actorUid: state.uid,
      fragmentIndex,
      fragId,
      playerName: state.me?.name || 'Host',
    });
    showNotice(`Reset Line ${fragmentIndex + 1} for a fresh round!`, 'info', 2500);
  } catch (err) {
    console.error('Redo fragment error:', err);
    showNotice(err?.message || 'Could not redo fragment.', 'error');
  }
}

function renderPartyFlowBanner(party) {
  const banner = el('partyFlowBanner');
  if (!banner) return;

  const phase = party?.phase || 'recording';
  const totalLines = Math.max(1, state.fragments.length);
  const idx = Math.max(0, Math.min(totalLines - 1, Number(party?.fragmentIndex) || 0));
  const players = state.roomData?.players || (state.me ? [state.me] : []);
  const submittedCount = (party?.submittedUids || []).length;
  const candidateCount = (party?.candidates || []).length;
  const votedCount = Object.keys(party?.votes || {}).length;
  const readyCount = (party?.readyUids || []).length;

  banner.classList.toggle('is-revote', phase === 'revote');
  banner.classList.toggle('is-finale', phase === 'finale');

  let kicker = `PARTY SHOWDOWN · LINE ${idx + 1} OF ${totalLines}`;
  let title = party?.statusBanner || `Line ${idx + 1} — Everyone Dubs!`;
  let desc = 'Listen to the original line, then hit Record Take.';
  let countLabel = `Takes In: ${submittedCount} / ${players.length}`;

  if (phase === 'recording') {
    kicker = `PARTY SHOWDOWN · RECORDING (${idx + 1}/${totalLines})`;
    title = `Line ${idx + 1} of ${totalLines} — Everyone Dub This Line!`;
    desc = state.isHost
      ? 'Everyone records the same line. Click Start Voting once players are ready!'
      : 'Hit Record Take before the host locks in voting!';
    countLabel = `Submitted: ${submittedCount} / ${players.length}`;
  } else if (phase === 'voting') {
    kicker = `PARTY SHOWDOWN · VOTING (${idx + 1}/${totalLines})`;
    title = `Vote for the Best Line ${idx + 1} Dub!`;
    desc = 'Listen to each candidate below and pick your favorite recording.';
    countLabel = `Votes Cast: ${votedCount}`;
  } else if (phase === 'revote') {
    kicker = `TIE-BREAKER RE-VOTE · TOP ${candidateCount}`;
    title = `Tied at ${party?.tiedVotesCount ?? 0} vote(s) — Final Re-Vote!`;
    desc = '1 re-vote between tied top takes only. If tied again, winner is chosen randomly!';
    countLabel = `Re-Votes: ${votedCount}`;
  } else if (phase === 'winner') {
    const win = party?.lastWinner;
    kicker = `ROUND WINNER · LINE ${idx + 1}/${totalLines}`;
    title = win ? `${win.playerName || 'Player'} Takes Line ${idx + 1}!` : `Line ${idx + 1} Winner Revealed!`;
    desc = 'Celebrate & click Ready Up to move forward together.';
    countLabel = `Ready: ${readyCount} / ${players.length}`;
  } else if (phase === 'finale') {
    kicker = `GROUP PREMIERE · FINALE WATCH PARTY`;
    title = 'Everyone Watches the Winning Final Cut Together!';
    desc = state.isHost
      ? 'Press Play for Everyone below to roll the stitched winning dub for all players.'
      : 'Sit back, watch the premiere, and fire live reactions!';
    countLabel = `Complete (${totalLines}/${totalLines} lines)`;
  }

  if (el('partyPhaseKicker')) el('partyPhaseKicker').textContent = kicker;
  if (el('partyPhaseTitle')) el('partyPhaseTitle').textContent = title;
  if (el('partyPhaseDesc')) el('partyPhaseDesc').textContent = desc;
  if (el('partyPhaseCount')) el('partyPhaseCount').textContent = countLabel;

  const track = el('partyStepTrack');
  if (track) {
    const winners = party?.winners || {};
    let html = '';
    state.fragments.forEach((f, i) => {
      const w = winners[f.id];
      const isCur = phase !== 'finale' && i === idx;
      const cls = `party-step-node${isCur ? ' is-current' : ''}${w ? ' is-done' : ''}`;
      const styleAttr = w ? ` style="--step-winner-color:${escapeHtml(w.playerColor || '#10B981')};"` : '';
      const dot = w ? '<span class="party-step-dot"></span>' : '';
      html += `<div class="${cls}"${styleAttr} title="Line ${i + 1}${w ? ` — Winner: ${escapeHtml(w.playerName || 'Player')}` : ''}">${dot}L${i + 1}</div>`;
    });
    const finCls = `party-step-node${phase === 'finale' ? ' is-current' : ''}`;
    html += `<div class="${finCls}" title="Collective Watch Party Finale">★ Watch</div>`;
    track.innerHTML = html;
  }

  const hostCtrls = el('partyHostControls');
  if (hostCtrls) {
    hostCtrls.style.display = state.isHost ? 'flex' : 'none';
    if (state.isHost) {
      if (el('partyStartVoteBtn')) {
        el('partyStartVoteBtn').style.display = phase === 'recording' ? 'inline-flex' : 'none';
        const activeFrag = state.fragments[idx];
        const takeCount = activeFrag ? Object.keys(state.takes[activeFrag.id] || {}).length : 0;
        el('partyStartVoteBtn').disabled = (submittedCount + takeCount) === 0;
      }
      if (el('partyCloseVoteBtn')) {
        el('partyCloseVoteBtn').style.display = (phase === 'voting' || phase === 'revote') ? 'inline-flex' : 'none';
      }
      if (el('partyRedoCurrentBtn')) {
        el('partyRedoCurrentBtn').style.display = phase !== 'finale' ? 'inline-flex' : 'none';
      }
      renderPartyRedoMenu(party);
    }
  }
}

function renderPartyVotingPanel(party) {
  const panel = el('partyVotingPanel');
  const grid = el('partyCandidatesGrid');
  if (!panel || !grid) return;

  const totalLines = Math.max(1, state.fragments.length);
  const idx = Math.max(0, Math.min(totalLines - 1, Number(party?.fragmentIndex) || 0));
  const frag = state.fragments[idx];
  const players = state.roomData?.players || (state.me ? [state.me] : []);
  const candidates = Array.isArray(party?.candidates) ? party.candidates : [];
  const votes = party?.votes || {};
  const isRevote = party?.phase === 'revote';
  const myVote = votes[state.uid] || null;
  const soloCandidate = candidates.length <= 1;

  if (el('partyRevoteBanner')) {
    el('partyRevoteBanner').style.display = isRevote ? 'block' : 'none';
  }
  if (el('partyVotingTitle')) {
    el('partyVotingTitle').textContent = isRevote
      ? `Tie-Breaker Re-Vote — Line ${idx + 1}`
      : `Vote for the Best Line ${idx + 1} Dub!`;
  }
  if (el('partyVotingSub')) {
    el('partyVotingSub').textContent = soloCandidate
      ? 'Only one take was submitted this round — others can vote to approve it.'
      : isRevote
        ? 'Vote once more between only the tied highest-voted takes!'
        : 'Audition each player\'s take, then cast 1 vote (you cannot vote for yourself).';
  }

  const eligibleVoters = soloCandidate
    ? players.filter((p) => p?.id && p.id !== candidates[0])
    : players.filter((p) => p?.id);
  if (el('partyVotingTallyStatus')) {
    el('partyVotingTallyStatus').textContent = `Votes: ${Object.keys(votes).length} / ${Math.max(1, eligibleVoters.length)}`;
  }

  grid.innerHTML = '';
  candidates.forEach((uid) => {
    const p = players.find((x) => x.id === uid) || {};
    const pName = p.name || (uid === state.uid ? (state.me?.name || 'You') : 'Player');
    const pColor = p.color || '#B285F5';
    const take = frag ? state.takes[frag.id]?.[uid] : null;
    const isSelf = uid === state.uid;
    const isVotedFor = myVote === uid;
    const isSpotlight = party?.spotlightUid === uid;
    const canVoteForThis = soloCandidate ? !isSelf : !isSelf;

    const card = document.createElement('div');
    card.className = `party-candidate-card${isVotedFor ? ' is-voted' : ''}${isSpotlight ? ' is-spotlight' : ''}`;
    card.style.setProperty('--cand-color', pColor);

    // Build compact mini waveform bars
    const trace = Array.isArray(take?.trace) && take.trace.length > 0 ? take.trace : [];
    const barCount = 18;
    let waveBarsHTML = '';
    for (let b = 0; b < barCount; b++) {
      const sample = trace.length > 0
        ? (trace[Math.min(trace.length - 1, Math.floor((b / barCount) * trace.length))] || 0.08)
        : (0.2 + ((b * 7) % 5) * 0.12);
      const pct = Math.max(14, Math.min(100, Math.round(sample * 100)));
      waveBarsHTML += `<span class="party-cand-bar" style="height:${pct}%;"></span>`;
    }

    const scoreHTML = (state.scoringMode && take && typeof take.score === 'number' && take.score > 0)
      ? `<span class="party-cand-score">★ ${take.score}%</span>`
      : '';

    card.innerHTML = `
      <div class="party-cand-top">
        <div class="party-cand-player">
          <span class="party-cand-dot"></span>
          <span class="party-cand-name">${escapeHtml(pName)}${isSelf ? ' (You)' : ''}</span>
        </div>
        ${scoreHTML}
      </div>
      <div class="party-cand-wave" aria-hidden="true">${waveBarsHTML}</div>
      <div class="party-cand-actions">
        <button type="button" class="btn party-cand-play-btn">${take?.buffer ? 'Play Take' : 'Syncing...'}</button>
        <button type="button" class="btn btn-primary party-cand-vote-btn${isVotedFor ? ' is-chosen' : ''}" ${!canVoteForThis ? 'disabled title="You cannot vote for your own recording"' : ''}>
          ${isVotedFor ? '✓ Voted' : (isSelf ? 'Yours' : 'Vote Best')}
        </button>
      </div>
      ${state.isHost ? `<button type="button" class="btn btn-ghost party-cand-spotlight-btn">Spotlight for All</button>` : ''}
    `;

    const playBtn = card.querySelector('.party-cand-play-btn');
    if (playBtn) {
      playBtn.disabled = !take?.buffer;
      playBtn.onclick = () => {
        if (frag) auditionPartyCandidate(uid, frag, card, playBtn, true);
      };
    }

    const voteBtn = card.querySelector('.party-cand-vote-btn');
    if (voteBtn && canVoteForThis) {
      voteBtn.onclick = async () => {
        try {
          await multiplayer.api.partyAction(state.roomId, {
            action: 'cast-vote',
            actorUid: state.uid,
            voterUid: state.uid,
            candidateUid: uid,
          });
        } catch (err) {
          showNotice(err?.message || 'Could not record vote.', 'warning');
        }
      };
    }

    const spotBtn = card.querySelector('.party-cand-spotlight-btn');
    if (spotBtn) {
      spotBtn.onclick = async () => {
        try {
          if (frag) auditionPartyCandidate(uid, frag, card, playBtn, true);
          await multiplayer.api.partyAction(state.roomId, {
            action: 'spotlight-take',
            actorUid: state.uid,
            candidateUid: uid,
            playerName: state.me?.name || 'Host',
          });
        } catch (err) {
          showNotice(err?.message || 'Could not spotlight take.', 'warning');
        }
      };
    }

    grid.appendChild(card);
  });
}

function renderPartyWinnerModal(party) {
  const modal = el('partyWinnerModal');
  if (!modal) return;
  const totalLines = Math.max(1, state.fragments.length);
  const idx = Math.max(0, Math.min(totalLines - 1, Number(party?.fragmentIndex) || 0));
  const frag = state.fragments[idx];
  const winner = party?.lastWinner || (frag ? party?.winners?.[frag.id] : null);
  const players = state.roomData?.players || (state.me ? [state.me] : []);
  const readySet = new Set(party?.readyUids || []);
  const readyCount = players.filter((p) => p?.id && readySet.has(p.id)).length;
  const allReady = players.length > 0 && readyCount >= players.length;
  const isMeReady = readySet.has(state.uid);
  const isLastLine = idx + 1 >= totalLines;

  if (winner) {
    const wColor = winner.playerColor || '#B285F5';
    const wName = winner.playerName || 'Player';
    if (el('partyWinnerBadge')) {
      el('partyWinnerBadge').textContent = winner.winReason === 'random_tiebreak'
        ? 'TIE-BREAK RANDOM WINNER'
        : winner.winReason === 'revote'
          ? 'RE-VOTE WINNER'
          : 'ROUND WINNER';
    }
    if (el('partyWinnerTitle')) el('partyWinnerTitle').textContent = `${wName} Wins Line ${idx + 1}!`;
    if (el('partyWinnerSub')) el('partyWinnerSub').textContent = `Line ${idx + 1} of ${totalLines} (${frag ? `${frag.start.toFixed(1)}s–${frag.end.toFixed(1)}s` : ''})`;
    if (el('partyWinnerHero')) el('partyWinnerHero').style.setProperty('--winner-color', wColor);
    if (el('partyWinnerAvatar')) el('partyWinnerAvatar').textContent = (wName[0] || '★').toUpperCase();
    if (el('partyWinnerName')) el('partyWinnerName').textContent = wName;
    if (el('partyWinnerReason')) {
      const voteWord = winner.votes === 1 ? 'vote' : 'votes';
      el('partyWinnerReason').textContent = winner.winReason === 'random_tiebreak'
        ? `Double tie broken randomly (${winner.votes || 0} ${voteWord})`
        : winner.winReason === 'revote'
          ? `Won the tie-breaker re-vote (${winner.votes || 0} ${voteWord})`
          : `Crowd favorite with ${winner.votes || 0} ${voteWord}`;
    }
  }

  const replayBtn = el('partyWinnerReplayBtn');
  if (replayBtn && winner && frag) {
    const hasWinAudio = Boolean(state.takes[frag.id]?.[winner.uid]?.buffer);
    replayBtn.disabled = !hasWinAudio;
    replayBtn.onclick = () => {
      auditionPartyCandidate(winner.uid, frag, null, replayBtn, true);
    };
  }

  if (el('partyReadyCount')) el('partyReadyCount').textContent = `${readyCount} / ${players.length} Ready`;
  const readyGrid = el('partyReadyGrid');
  if (readyGrid) {
    readyGrid.innerHTML = players.map((p, pIdx) => {
      const isReady = readySet.has(p.id);
      const pName = p.name || getAnonymousPlayerName(pIdx);
      const pColor = p.color || PLAYER_COLORS[pIdx % PLAYER_COLORS.length];
      return `<span class="party-ready-chip${isReady ? ' is-ready' : ''}">
        <span class="party-ready-chip-dot" style="background:${escapeHtml(pColor)};"></span>
        <span>${escapeHtml(pName)}</span>
        <span>${isReady ? '✓' : '…'}</span>
      </span>`;
    }).join('');
  }

  const readyUpBtn = el('partyReadyUpBtn');
  if (readyUpBtn) {
    readyUpBtn.disabled = isMeReady;
    readyUpBtn.classList.toggle('is-ready', isMeReady);
    readyUpBtn.textContent = isMeReady
      ? (isLastLine ? '✓ Ready for Final Premiere!' : '✓ Ready! Waiting for cast...')
      : (isLastLine ? 'Ready for Final Watch Party!' : 'Ready for Next Line');
    readyUpBtn.onclick = async () => {
      try {
        await multiplayer.api.partyAction(state.roomId, {
          action: 'ready-next',
          actorUid: state.uid,
          uid: state.uid,
        });
      } catch (err) {
        showNotice(err?.message || 'Could not update ready state.', 'warning');
      }
    };
  }

  const hostFooter = el('partyWinnerHostFooter');
  if (hostFooter) {
    hostFooter.style.display = state.isHost ? 'flex' : 'none';
    if (state.isHost) {
      if (el('partyWinnerRedoBtn')) {
        el('partyWinnerRedoBtn').onclick = () => {
          if (frag) triggerHostRedoFragment(idx, frag.id);
        };
      }
      if (el('partyWinnerNextBtn')) {
        el('partyWinnerNextBtn').disabled = !allReady;
        el('partyWinnerNextBtn').textContent = isLastLine ? 'Start Watch Party →' : 'Next Line →';
        el('partyWinnerNextBtn').onclick = async () => {
          try {
            await multiplayer.api.partyAction(state.roomId, {
              action: 'advance-fragment',
              actorUid: state.uid,
              force: false,
            });
          } catch (err) {
            showNotice(err?.message || 'Waiting for players to ready up.', 'info');
          }
        };
      }
      if (el('partyForceAdvanceBtn')) {
        el('partyForceAdvanceBtn').style.display = !allReady ? 'inline-flex' : 'none';
        el('partyForceAdvanceBtn').onclick = async () => {
          try {
            await multiplayer.api.partyAction(state.roomId, {
              action: 'advance-fragment',
              actorUid: state.uid,
              force: true,
            });
          } catch (err) {
            showNotice(err?.message || 'Could not advance.', 'error');
          }
        };
      }
    }
  }
}

function renderPartyFinaleEmotes() {
  const bar = el('partyFinaleEmoteBar');
  if (!bar) return;
  if (bar.childElementCount > 0) return;
  MULTIPLAYER_EMOTES.forEach((emote) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'party-finale-emote-btn';
    btn.title = `React ${emote.label}`;
    btn.textContent = emote.emoji;
    btn.onclick = () => sendMultiplayerEmote(emote);
    bar.appendChild(btn);
  });
}

function renderPartyFinalePanel(party) {
  renderPartyFinaleEmotes();
  const isPlaying = Boolean(party?.finalePlayback?.playing);
  if (el('partyFinaleHostControls')) {
    el('partyFinaleHostControls').style.display = state.isHost ? 'flex' : 'none';
  }
  if (el('partyFinaleGuestNote')) {
    el('partyFinaleGuestNote').style.display = state.isHost ? 'none' : 'block';
  }
  if (el('partyFinalePlayBtn')) {
    el('partyFinalePlayBtn').disabled = isPlaying;
  }
  if (el('partyFinalePauseBtn')) {
    el('partyFinalePauseBtn').disabled = !isPlaying;
  }
  if (el('partyFinaleSub')) {
    el('partyFinaleSub').textContent = isPlaying
      ? 'NOW PLAYING FOR EVERYONE — Watch your stitched group dub & react live!'
      : 'All winning dubs are locked in! Watch the complete movie together.';
  }

  const dur = Math.max(0.1, state.duration || 1);
  if (!partyFinaleState.playing && el('partyFinaleTime')) {
    const pos = Math.min(dur, Math.max(0, Number(party?.finalePlayback?.position) || 0));
    el('partyFinaleTime').textContent = `${formatTimeSecTenths(pos)} / ${formatTimeSecTenths(dur)}`;
    if (el('partyFinaleProgressFill')) {
      el('partyFinaleProgressFill').style.width = `${Math.min(100, (pos / dur) * 100)}%`;
    }
  }

  const winnersGrid = el('partyFinaleWinnersGrid');
  if (winnersGrid) {
    const winners = party?.winners || {};
    winnersGrid.innerHTML = state.fragments.map((f, i) => {
      const w = winners[f.id];
      const wName = w?.playerName || 'Original Clip';
      const wColor = w?.playerColor || '#9E93AD';
      return `<div class="party-finale-winner-chip">
        <span class="party-step-dot" style="background:${escapeHtml(wColor)};"></span>
        <span class="party-finale-winner-line">L${i + 1}</span>
        <span class="party-finale-winner-actor">${escapeHtml(wName)}</span>
      </div>`;
    }).join('');
  }

  switchPartyFinaleTab(partyFinaleActiveTab);
  renderPartyFinaleResults(party);
}

function switchPartyFinaleTab(tab = 'watch') {
  partyFinaleActiveTab = tab === 'results' ? 'results' : 'watch';
  const isResults = partyFinaleActiveTab === 'results';

  if (el('partyFinaleTabWatch')) {
    el('partyFinaleTabWatch').classList.toggle('is-active', !isResults);
    el('partyFinaleTabWatch').setAttribute('aria-selected', !isResults ? 'true' : 'false');
  }
  if (el('partyFinaleTabResults')) {
    el('partyFinaleTabResults').classList.toggle('is-active', isResults);
    el('partyFinaleTabResults').setAttribute('aria-selected', isResults ? 'true' : 'false');
  }
  if (el('partyFinaleWatchView')) {
    el('partyFinaleWatchView').style.display = isResults ? 'none' : 'flex';
  }
  if (el('partyFinaleResultsView')) {
    el('partyFinaleResultsView').style.display = isResults ? 'flex' : 'none';
  }
}

function computePartyLeaderboard(party) {
  const players = Array.isArray(state.roomData?.players) && state.roomData.players.length > 0
    ? state.roomData.players
    : (state.me ? [state.me] : []);
  const hostId = state.roomData?.hostId || '';
  const map = new Map();

  players.forEach((p, idx) => {
    if (!p?.id) return;
    map.set(p.id, {
      uid: p.id,
      name: p.name || getAnonymousPlayerName(idx),
      color: p.color || PLAYER_COLORS[idx % PLAYER_COLORS.length],
      isHost: p.id === hostId,
      votes: 0,
      linesWon: 0,
    });
  });

  const ensureEntry = (uid, fallbackName = 'Player', fallbackColor = '#B285F5') => {
    if (!map.has(uid)) {
      map.set(uid, {
        uid,
        name: fallbackName,
        color: fallbackColor,
        isHost: uid === hostId,
        votes: 0,
        linesWon: 0,
      });
    }
    return map.get(uid);
  };

  const winners = party?.winners || {};
  Object.values(winners).forEach((w) => {
    if (!w) return;
    if (w.uid) {
      const winnerEntry = ensureEntry(w.uid, w.playerName, w.playerColor);
      winnerEntry.linesWon += 1;
    }
    const tallyMaps = [];
    if (w.initialTally && typeof w.initialTally === 'object') tallyMaps.push(w.initialTally);
    if (w.tally && typeof w.tally === 'object') tallyMaps.push(w.tally);
    tallyMaps.forEach((tMap) => {
      Object.entries(tMap).forEach(([candUid, count]) => {
        const entry = ensureEntry(candUid);
        entry.votes += Math.max(0, Number(count) || 0);
      });
    });
  });

  const rows = [...map.values()].sort((a, b) => {
    if (b.votes !== a.votes) return b.votes - a.votes;
    if (b.linesWon !== a.linesWon) return b.linesWon - a.linesWon;
    return a.name.localeCompare(b.name);
  });

  const totalVotesCast = rows.reduce((sum, r) => sum + r.votes, 0);
  const maxVotes = rows.length > 0 ? Math.max(1, rows[0].votes) : 1;

  let currentRank = 1;
  return {
    totalVotesCast,
    maxVotes,
    totalLinesWon: Object.keys(winners).length,
    rows: rows.map((row, idx) => {
      if (idx > 0 && (row.votes !== rows[idx - 1].votes || row.linesWon !== rows[idx - 1].linesWon)) {
        currentRank = idx + 1;
      }
      const sharePct = totalVotesCast > 0 ? Math.round((row.votes / totalVotesCast) * 100) : 0;
      return { ...row, rank: currentRank, sharePct };
    }),
  };
}

function renderPartyFinaleResults(party) {
  const summaryEl = el('partyFinaleResultsSummary');
  const listEl = el('partyFinaleResultsList');
  if (!summaryEl || !listEl) return;

  const { rows, totalVotesCast, maxVotes, totalLinesWon } = computePartyLeaderboard(party);
  const topLeader = rows[0];
  const leaderLabel = topLeader && totalVotesCast > 0
    ? `Leader: <strong>${escapeHtml(topLeader.name)}</strong> (${topLeader.votes} vote${topLeader.votes === 1 ? '' : 's'})`
    : 'No votes cast yet';

  summaryEl.innerHTML = `
    <span>${leaderLabel}</span>
    <span><strong>${totalVotesCast}</strong> total vote${totalVotesCast === 1 ? '' : 's'} · <strong>${totalLinesWon}</strong> / ${Math.max(1, state.fragments.length)} lines awarded</span>
  `;

  if (rows.length === 0) {
    listEl.innerHTML = `<div style="font-size:12.5px; color:var(--text-dim); padding:8px 2px;">No participants found in this room.</div>`;
    return;
  }

  listEl.innerHTML = rows.map((r) => {
    const isChampion = r.rank === 1 && totalVotesCast > 0;
    const isSelf = r.uid === state.uid;
    const barPct = totalVotesCast > 0 ? Math.max(4, Math.round((r.votes / maxVotes) * 100)) : 0;
    const tags = [
      isSelf ? '(You)' : '',
      r.isHost ? '(Host)' : '',
    ].filter(Boolean).join(' ');
    const winsText = `${r.linesWon} line${r.linesWon === 1 ? '' : 's'} won`;
    const shareText = `${r.sharePct}% of votes`;

    return `
      <div class="party-result-row${isChampion ? ' is-champion' : ''}" style="--player-color:${escapeHtml(r.color)};">
        <div class="party-result-rank">#${r.rank}</div>
        <div class="party-result-avatar" aria-hidden="true"></div>
        <div class="party-result-main">
          <div class="party-result-name-row">
            <span class="party-result-name">${escapeHtml(r.name)}${tags ? ` <span style="font-weight:500;color:var(--text-dim);font-size:11.5px;">${tags}</span>` : ''}</span>
            <span class="party-result-meta">${winsText} · ${shareText}</span>
          </div>
          <div class="party-result-bar-track" aria-hidden="true">
            <div class="party-result-bar-fill" style="width:${barPct}%;"></div>
          </div>
        </div>
        <div class="party-result-score-col">
          <span class="party-result-votes">${r.votes}</span>
          <span class="party-result-votes-label">vote${r.votes === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
  }).join('');
}

function stopPartyFinalePlayback() {
  if (partyFinaleState.rafId) {
    cancelAnimationFrame(partyFinaleState.rafId);
    partyFinaleState.rafId = null;
  }
  partyFinaleState.sources.forEach((s) => {
    try { s.stop(); } catch (e) {}
    try { s.disconnect(); } catch (e) {}
  });
  partyFinaleState.sources = [];
  partyFinaleState.bgGain = null;
  partyFinaleState.playing = false;
  const v = el('mainVideo');
  if (v && !state.isPlaying) {
    try { v.pause(); } catch (e) {}
  }
  if (el('monitorBadgeText') && !state.isPlaying) {
    el('monitorBadgeText').textContent = 'Idle';
    el('monitorBadge')?.classList.remove('live');
  }
}

function pausePartyFinalePlayback() {
  stopPartyFinalePlayback();
  updateMonitorSubtitle();
}

async function startPartyFinalePlayback(fp = {}) {
  stopPartyFinalePlayback();
  stopPartyAudition();
  stopPlayback(true);

  const v = el('mainVideo');
  if (!v) return;
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {});
  }

  const dur = Math.max(0.1, state.duration || v.duration || 1);
  const startPos = Math.max(0, Math.min(dur - 0.05, Number(fp.position) || 0));

  v.muted = true;
  v.playbackRate = 1;
  try { v.currentTime = startPos; } catch (e) {}

  await new Promise((resolve) => {
    if (Math.abs((v.currentTime || 0) - startPos) < 0.08) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', finish);
      resolve();
    };
    v.addEventListener('seeked', finish);
    setTimeout(finish, 220);
  });

  const t0 = ctx.currentTime + 0.05;
  const mixVol = getMixVolume();
  const sources = [];
  let bgGain = null;

  const bgBuf = state.backgroundBuffer || state.masterBuffer;
  if (bgBuf) {
    const bgSrc = ctx.createBufferSource();
    bgSrc.buffer = bgBuf;
    bgGain = ctx.createGain();
    bgGain.gain.value = mixVol;
    bgSrc.connect(bgGain);
    bgGain.connect(ctx.destination);
    const safeBgOffset = Math.max(0, Math.min(bgBuf.duration - 0.02, startPos));
    bgSrc.start(t0, safeBgOffset);
    sources.push(bgSrc);
  }

  const latencySec = (Number(settings.get('micLatencyMs')) || 0) / 1000;
  const isAutoNorm = Boolean(settings.get('autoNormalize'));
  const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
  const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;
  const partyWinners = getPartyState()?.winners || {};

  state.fragments.forEach((f) => {
    const takes = state.takes[f.id] || {};
    const winUid = partyWinners[f.id]?.uid;
    const chosenUid = (winUid && takes[winUid]?.buffer)
      ? winUid
      : Object.keys(takes).find((uid) => takes[uid]?.buffer);

    if (chosenUid && takes[chosenUid]?.buffer) {
      let buf = takes[chosenUid].buffer;
      if (isAutoNorm && !takes[chosenUid].normalized) {
        try {
          const norm = normalizeAudioBuffer(ctx, buf, targetDb, { silenceThresholdDb: silenceFloor });
          buf = norm.buffer;
        } catch (e) {}
      }
      const takeStart = Math.max(0, (Number(f.start) || 0) + latencySec);
      const takeEnd = takeStart + (buf.duration || 0);
      if (takeEnd > startPos + 0.02) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        if (takeStart >= startPos) {
          src.start(t0 + (takeStart - startPos), 0);
        } else {
          src.start(t0, Math.max(0, startPos - takeStart));
        }
        sources.push(src);
      }
    } else if (!state.backgroundBuffer && state.masterBuffer) {
      // Mono fallback already includes full masterBuffer
    } else {
      const seg = sliceMasterBuffer(f.start, f.end);
      if (seg && f.end > startPos + 0.02) {
        const src = ctx.createBufferSource();
        src.buffer = seg;
        src.connect(ctx.destination);
        if (f.start >= startPos) {
          src.start(t0 + (f.start - startPos), 0);
        } else {
          src.start(t0, Math.max(0, startPos - f.start));
        }
        sources.push(src);
      }
    }
  });

  partyFinaleState.playing = true;
  partyFinaleState.sources = sources;
  partyFinaleState.bgGain = bgGain;
  if (el('monitorBadgeText')) {
    el('monitorBadgeText').textContent = 'Premiere';
    el('monitorBadge')?.classList.add('live');
  }

  v.play().catch(() => {});

  const tickFinale = () => {
    if (!partyFinaleState.playing) return;
    const cur = v.currentTime || 0;
    const total = Math.max(0.1, state.duration || v.duration || 1);
    if (el('partyFinaleTime')) {
      el('partyFinaleTime').textContent = `${formatTimeSecTenths(cur)} / ${formatTimeSecTenths(total)}`;
    }
    if (el('partyFinaleProgressFill')) {
      el('partyFinaleProgressFill').style.width = `${Math.min(100, (cur / total) * 100)}%`;
    }

    // Show active fragment subtitles cleanly during collective premiere
    if (settings.get('showSubtitles') && el('monitorSubtitleOverlay') && el('monitorSubtitleText')) {
      const activeSubFrag = state.fragments.find((f) => cur >= f.start && cur <= f.end);
      const subText = activeSubFrag?.transcript?.trim() || '';
      if (subText) {
        el('monitorSubtitleText').textContent = subText;
        el('monitorSubtitleOverlay').style.display = 'block';
      } else {
        el('monitorSubtitleOverlay').style.display = 'none';
      }
    }

    renderMasterCanvas();

    if (v.ended || cur >= total - 0.05) {
      stopPartyFinalePlayback();
      if (el('partyFinaleTime')) el('partyFinaleTime').textContent = `${formatTimeSecTenths(total)} / ${formatTimeSecTenths(total)}`;
      if (el('partyFinaleProgressFill')) el('partyFinaleProgressFill').style.width = '100%';
      if (isPartyHost() && state.roomId) {
        multiplayer.api.partyAction(state.roomId, {
          action: 'finale-control',
          actorUid: state.uid,
          command: 'pause',
          position: 0,
        }).catch(() => {});
      }
      return;
    }
    partyFinaleState.rafId = requestAnimationFrame(tickFinale);
  };
  partyFinaleState.rafId = requestAnimationFrame(tickFinale);
}

function syncFinalePlayback(party) {
  const fp = party?.finalePlayback;
  if (!fp) return;
  const seq = Number(fp.seq) || 0;
  if (seq === lastFinaleSeq) return;
  lastFinaleSeq = seq;
  if (fp.playing) {
    startPartyFinalePlayback(fp);
  } else {
    pausePartyFinalePlayback();
  }
}

function syncPartyUI() {
  const inStudio = Boolean(el('studioScreen')?.classList.contains('active'));
  const activeParty = isPartyMode() && inStudio;
  syncPartyModeClasses();

  if (!activeParty) {
    if (el('partyFlowBanner')) el('partyFlowBanner').style.display = 'none';
    if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'none';
    if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'none';
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
    if (el('lanePanel')) el('lanePanel').style.display = '';
    if (el('studioTransport')) el('studioTransport').style.display = '';
    return;
  }

  const party = getPartyState() || {
    enabled: true,
    phase: 'recording',
    fragmentIndex: state.currentIndex || 0,
    submittedUids: [],
    candidates: [],
    votes: {},
    winners: {},
    readyUids: [],
  };

  if (el('partyFlowBanner')) el('partyFlowBanner').style.display = 'flex';
  renderPartyFlowBanner(party);

  const phase = party.phase || 'recording';
  const hostEditing = Boolean(state.isHost && state.editMode);
  if (phase === 'recording') {
    if (el('lanePanel')) el('lanePanel').style.display = '';
    if (el('studioTransport')) el('studioTransport').style.display = '';
    if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'none';
    if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'none';
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
    checkRecordAbility();
  } else if (phase === 'voting' || phase === 'revote') {
    if (el('lanePanel')) el('lanePanel').style.display = hostEditing ? '' : 'none';
    if (el('studioTransport')) el('studioTransport').style.display = 'none';
    if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'flex';
    if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'none';
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
    renderPartyVotingPanel(party);
  } else if (phase === 'winner') {
    if (el('lanePanel')) el('lanePanel').style.display = '';
    if (el('studioTransport')) el('studioTransport').style.display = 'none';
    if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'none';
    if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'none';
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.add('active');
    renderPartyWinnerModal(party);
  } else if (phase === 'finale') {
    if (el('lanePanel')) el('lanePanel').style.display = hostEditing ? '' : 'none';
    if (el('studioTransport')) el('studioTransport').style.display = 'none';
    if (el('partyVotingPanel')) el('partyVotingPanel').style.display = 'none';
    if (el('partyFinalePanel')) el('partyFinalePanel').style.display = 'flex';
    if (el('partyWinnerModal')) el('partyWinnerModal').classList.remove('active');
    renderPartyFinalePanel(party);
  }
}

function syncPartyStateFromRoom(roomData) {
  const party = roomData?.party;
  if (!party || !isPartyMode()) {
    syncPartyUI();
    return;
  }

  const serial = Number(party.roundSerial) || 1;
  const phase = party.phase || 'recording';
  const serialChanged = serial !== lastPartyRoundSerial;
  const phaseChanged = phase !== lastPartyPhase;

  if (serialChanged) {
    lastPartyRoundSerial = serial;
    stopPartyAudition();
    if (phase !== 'finale') stopPartyFinalePlayback();
    stopPlayback(true);
    // Clear stale local takes for active fragment if server wiped them on a Redo
    const targetFrag = state.fragments[party.fragmentIndex];
    if (targetFrag && phase === 'recording' && (!party.submittedUids || party.submittedUids.length === 0)) {
      if (state.takes[targetFrag.id]) {
        delete state.takes[targetFrag.id];
      }
    }
  }

  if (phaseChanged) {
    lastPartyPhase = phase;
    stopPartyAudition();
    if (phase !== 'recording') stopPlayback(true);
    if (phase === 'revote') {
      showNotice(`Tie detected! Re-voting between the top ${party.candidates?.length || 2} takes!`, 'warning', 3200);
    } else if (phase === 'winner' && party.lastWinner) {
      const winnerKey = `${party.fragmentIndex}:${party.lastWinner.uid}:${serial}`;
      if (winnerKey !== lastPartyWinnerKey) {
        lastPartyWinnerKey = winnerKey;
        const msg = party.lastWinner.winReason === 'random_tiebreak'
          ? `Second tie! Random wheel picked ${party.lastWinner.playerName}!`
          : `${party.lastWinner.playerName} wins Line ${party.fragmentIndex + 1}!`;
        showNotice(msg, 'success', 3200);
      }
    } else if (phase === 'finale') {
      partyFinaleActiveTab = 'watch';
      showNotice('All lines dubbed! Welcome to the Finale Watch Party!', 'success', 3600);
    }
  }

  if (phase !== 'finale' && typeof party.fragmentIndex === 'number' && party.fragmentIndex !== state.currentIndex) {
    if (!(state.isHost && state.editMode) || serialChanged) {
      if (state.fragments[party.fragmentIndex]) {
        selectFragment(party.fragmentIndex, false, true);
      }
    }
  }

  if (phase === 'finale') {
    syncFinalePlayback(party);
  } else {
    stopPartyFinalePlayback();
  }

  renderFragmentList();
  renderMasterCanvas();
  if (state.fragments[state.currentIndex]) {
    drawWave(state.fragments[state.currentIndex]);
  }
  syncPartyUI();
}

if (typeof document !== 'undefined') {
  if (el('partyStartVoteBtn')) {
    el('partyStartVoteBtn').onclick = async () => {
      if (!isPartyHost() || !state.roomId) return;
      const f = state.fragments[state.currentIndex];
      try {
        await multiplayer.api.partyAction(state.roomId, {
          action: 'start-voting',
          actorUid: state.uid,
          fragId: f?.id,
        });
      } catch (err) {
        showNotice(err?.message || 'Could not start voting.', 'warning');
      }
    };
  }

  if (el('partyCloseVoteBtn')) {
    el('partyCloseVoteBtn').onclick = async () => {
      if (!isPartyHost() || !state.roomId) return;
      try {
        await multiplayer.api.partyAction(state.roomId, {
          action: 'close-voting',
          actorUid: state.uid,
        });
      } catch (err) {
        showNotice(err?.message || 'Could not close voting.', 'warning');
      }
    };
  }

  if (el('partyRedoCurrentBtn')) {
    el('partyRedoCurrentBtn').onclick = () => {
      const idx = getPartyState()?.fragmentIndex ?? state.currentIndex;
      const f = state.fragments[idx];
      if (f) triggerHostRedoFragment(idx, f.id);
    };
  }

  if (el('partyRedoAnyBtn') && el('partyRedoMenu')) {
    el('partyRedoAnyBtn').onclick = (e) => {
      e.stopPropagation();
      const menu = el('partyRedoMenu');
      const isOpen = menu.style.display !== 'none';
      if (isOpen) {
        closePartyRedoMenu();
      } else {
        renderPartyRedoMenu(getPartyState());
        menu.style.display = 'flex';
        el('partyRedoAnyBtn').setAttribute('aria-expanded', 'true');
      }
    };
    document.addEventListener('click', (e) => {
      const wrap = el('partyRedoPickerWrap');
      if (wrap && !wrap.contains(e.target)) {
        closePartyRedoMenu();
      }
    });
  }

  if (el('partyFinalePlayBtn')) {
    el('partyFinalePlayBtn').onclick = async () => {
      if (!isPartyHost() || !state.roomId) return;
      const v = el('mainVideo');
      const cur = (v && Number.isFinite(v.currentTime) && v.currentTime < (state.duration || 1) - 0.2) ? v.currentTime : 0;
      await multiplayer.api.partyAction(state.roomId, {
        action: 'finale-control',
        actorUid: state.uid,
        command: 'play',
        position: cur,
      }).catch((err) => showNotice(err?.message || 'Could not start playback.', 'error'));
    };
  }

  if (el('partyFinalePauseBtn')) {
    el('partyFinalePauseBtn').onclick = async () => {
      if (!isPartyHost() || !state.roomId) return;
      const v = el('mainVideo');
      const cur = (v && Number.isFinite(v.currentTime)) ? v.currentTime : 0;
      await multiplayer.api.partyAction(state.roomId, {
        action: 'finale-control',
        actorUid: state.uid,
        command: 'pause',
        position: cur,
      }).catch((err) => showNotice(err?.message || 'Could not pause playback.', 'error'));
    };
  }

  if (el('partyFinaleRestartBtn')) {
    el('partyFinaleRestartBtn').onclick = async () => {
      if (!isPartyHost() || !state.roomId) return;
      await multiplayer.api.partyAction(state.roomId, {
        action: 'finale-control',
        actorUid: state.uid,
        command: 'restart',
        position: 0,
      }).catch((err) => showNotice(err?.message || 'Could not restart playback.', 'error'));
    };
  }

  if (el('partyFinaleTabWatch')) {
    el('partyFinaleTabWatch').onclick = () => switchPartyFinaleTab('watch');
  }
  if (el('partyFinaleTabResults')) {
    el('partyFinaleTabResults').onclick = () => {
      switchPartyFinaleTab('results');
      renderPartyFinaleResults(getPartyState());
    };
  }
}




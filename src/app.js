
import { createMultiplayerClient } from './network.js';
import { initAsteroidsBackground, startAsteroids, stopAsteroids, setAsteroidsMode } from './asteroidsBackground.js';
import { settings } from './settings.js';
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

const PLAYER_COLORS = ['#B285F5', '#10B981', '#E8A33D', '#3B82F6'];

const state = {
  uid: null,
  me: null,       // { id, name, color }
  roomId: null,
  isHost: false,
  isSingleplayer: false,
  scoringMode: false,
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
  const num = Math.min(4, Math.max(1, (slotIndex || 0) + 1));
  return `anon${num}`;
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

  // Deduplication: if exact same message is currently visible, refresh its pulse
  const existing = Array.from(container.children).find(t => t.querySelector('.toast-text')?.textContent === msg);
  if (existing) {
    existing.classList.remove('fading-out');
    existing.style.animation = 'none';
    existing.offsetHeight; /* trigger reflow */
    existing.style.animation = 'toastSlideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
    return;
  }

  // Cap number of simultaneous toasts to avoid clutter
  while (container.children.length >= 4) {
    container.removeChild(container.firstChild);
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
    toast.classList.add('fading-out');
    setTimeout(() => {
      if(toast.parentNode) toast.parentNode.removeChild(toast);
    }, 420);
  };

  closeBtn.onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };
  toast.onclick = dismiss;

  container.appendChild(toast);

  if(durationMs > 0){
    setTimeout(dismiss, durationMs);
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

  // Settings Modal Controller & Helpers
  function openSettingsModal() {
    syncSettingsUI();
    if (el('settingsModal')) {
      el('settingsModal').classList.add('active');
    }
  }

  function closeSettingsModal() {
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

    const latency = settings.get('micLatencyMs') ?? 0;
    if (el('settingLatencyRange')) el('settingLatencyRange').value = String(latency);
    if (el('settingLatencyVal')) el('settingLatencyVal').textContent = `${latency > 0 ? '+' : ''}${latency} ms`;

    if (el('settingAutoAdvance')) el('settingAutoAdvance').checked = Boolean(settings.get('autoAdvance'));
    if (el('settingShowSubtitles')) el('settingShowSubtitles').checked = Boolean(settings.get('showSubtitles'));
    const astMode = settings.get('asteroidsMode') || 'glow';
    if (el('settingAsteroidsMode')) el('settingAsteroidsMode').value = astMode;
    updateMonitorSubtitle();

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

  // Bind settings modal controls
  if (el('settingsBtnSetup')) el('settingsBtnSetup').onclick = openSettingsModal;
  if (el('settingsBtnMp')) el('settingsBtnMp').onclick = openSettingsModal;
  if (el('settingsBtnLobby')) el('settingsBtnLobby').onclick = openSettingsModal;
  if (el('settingsBtnStudio')) el('settingsBtnStudio').onclick = openSettingsModal;
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
        enabled ? "Keyboard shortcuts enabled (Space, R, L, P, arrows)." : "Keyboard shortcuts disabled.",
        "info",
        2200
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

  const advancedToggleBtn = el('advancedToggleBtn');
  const advancedSettingsDrawer = el('advancedSettingsDrawer');
  const advancedArrow = el('advancedArrow');
  if (advancedToggleBtn && advancedSettingsDrawer) {
    advancedToggleBtn.onclick = () => {
      const isOpen = advancedSettingsDrawer.classList.toggle('is-open');
      advancedToggleBtn.classList.toggle('is-open', isOpen);
      if (advancedArrow) {
        advancedArrow.innerHTML = isOpen ? '&#x25B2;' : '&#x25BC;';
      }
      advancedToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };
  }

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
      // 1. If currently typing inside any input or editable field, never intercept typing
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const isInput = activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable;
      if (isInput) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
        }
        return;
      }

      // 2. Escape closes modals or stops playback
      if (e.key === 'Escape') {
        if (el('settingsModal')?.classList.contains('active')) {
          closeSettingsModal();
          return;
        }
        if (el('confirmModal')?.classList.contains('active')) {
          el('confirmModal').classList.remove('active');
          confirmCallback = null;
          return;
        }
        if (state.isPlaying) {
          stopPlayback();
          return;
        }
      }

      // 3. Toggle Settings Modal ('s', 'S', or '?')
      if (e.key === 's' || e.key === 'S' || e.key === '?') {
        e.preventDefault();
        if (el('settingsModal')?.classList.contains('active')) {
          closeSettingsModal();
        } else {
          openSettingsModal();
        }
        return;
      }

      // 4. Check if keyboard shortcuts are enabled by user in settings
      if (!settings.get('keyboardShortcuts')) return;

      const studioActive = el('studioScreen')?.classList.contains('active');

      // Space: Play Takes / Pause / Resume
      if (e.code === 'Space') {
        e.preventDefault();
        if (studioActive) {
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

      // R: Record Take (or stop recording)
      if (e.code === 'KeyR') {
        if (studioActive) {
          e.preventDefault();
          if (state.isPlaying && state.pb?.mode === 'record') {
            finishPlayback();
          } else if (el('recordBtn') && !el('recordBtn').disabled) {
            el('recordBtn').click();
          }
        }
        return;
      }

      // L: Listen Original
      if (e.code === 'KeyL') {
        if (studioActive && el('listenBtn') && !el('listenBtn').disabled) {
          e.preventDefault();
          el('listenBtn').click();
        }
        return;
      }

      // P: Pause / Resume
      if (e.code === 'KeyP') {
        if (studioActive && el('pauseBtn') && !el('pauseBtn').disabled) {
          e.preventDefault();
          el('pauseBtn').click();
        }
        return;
      }

      // Left Arrow / '[' : Previous Line
      if (e.code === 'ArrowLeft' || e.code === 'BracketLeft') {
        if (studioActive && el('prevFragBtn') && !el('prevFragBtn').disabled) {
          e.preventDefault();
          el('prevFragBtn').click();
        }
        return;
      }

      // Right Arrow / ']' : Next Line
      if (e.code === 'ArrowRight' || e.code === 'BracketRight') {
        if (studioActive && el('nextFragBtn') && !el('nextFragBtn').disabled) {
          e.preventDefault();
          el('nextFragBtn').click();
        }
        return;
      }

      // U: Undo (Host)
      if (e.code === 'KeyU') {
        if (studioActive && state.isHost && el('undoBtn') && !el('undoBtn').disabled) {
          e.preventDefault();
          el('undoBtn').click();
        }
        return;
      }

      // E: Toggle Edit Splits (Host)
      if (e.code === 'KeyE') {
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
        if (studioActive) {
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

  const savedDubsBtn = el('savedDubsBtn');
  if (savedDubsBtn) {
    savedDubsBtn.onclick = () => {
      renderSavedDubsScreen();
      switchScreen('savedDubsScreen');
    };
  }

  const savedDubsBackBtn = el('savedDubsBackBtn');
  if (savedDubsBackBtn) savedDubsBackBtn.onclick = () => switchScreen('setupScreen');

  const clearSavedDubsBtn = el('clearSavedDubsBtn');
  if (clearSavedDubsBtn) {
    clearSavedDubsBtn.onclick = () => {
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
  state.editMode = false;
  state.undoStack = [];
  state.playerActivities = {};
  autoTranscribedFragKeys.clear();
  autoTranscribeKeyMissing = false;

  if (el('undoBtn')) el('undoBtn').disabled = true;
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

  switchScreen('setupScreen');
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

  const playMultiplayerBtn = el('playMultiplayerBtn');
  if (playMultiplayerBtn) {
    playMultiplayerBtn.onclick = () => {
      switchScreen('multiplayerScreen');
      setTimeout(() => {
        el('playerNameInput')?.focus();
      }, 120);
    };
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
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (el(id)) el(id).classList.add('active');
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

function renderLobbyPlayers(players, hostId){
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

if (el('singleplayerBtn')) {
  el('singleplayerBtn').onclick = () => {
    const inputVal = el('playerNameInput')?.value.trim();
    const name = inputVal || 'Solo Dubber';
    state.isSingleplayer = true;
    state.uid = 'local_player';
    state.isHost = true;
    state.roomId = 'LOCAL';
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
      fragments: []
    };
    
    updateLobbyCodeUI('SOLO');
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
      state.roomId = roomId;
      state.isHost = true;
      state.isSingleplayer = false;
      state.scoringMode = Boolean(el('scoringToggle')?.checked);
      state.me = { id: state.uid, name, color: PLAYER_COLORS[0], ready: false };
      state.players = [state.me];
      
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', roomId);
      await fb.setDoc(roomRef, {
        id: roomId,
        hostId: state.uid,
        players: [state.me],
        status: 'lobby',
        videoName: null,
        videoSize: null,
        scoringMode: state.scoringMode,
        fragments: []
      });
      
      if(el('scoringToggle')) el('scoringToggle').disabled = false;
      if(el('scoringHostNote')) el('scoringHostNote').style.display = 'none';
      if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

      updateLobbyCodeUI(roomId);
      listenToRoom();
      switchScreen('lobbyScreen');
      showNotice(`Room created! Code: ${roomId}`, "success", 3000);
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
    if(data.players && data.players.length >= 4) return showNotice("This room is already full (maximum 4 players).", "warning");
    if(data.status !== 'lobby') return showNotice("This room has already started its studio session.", "warning");

    const existingCount = Array.isArray(data.players) ? data.players.length : 1;
    const inputVal = el('playerNameInput')?.value.trim();
    const name = inputVal || getAnonymousPlayerName(existingCount);

    const color = PLAYER_COLORS[existingCount % PLAYER_COLORS.length];
    state.me = { id: state.uid, name, color, ready: false };
    state.roomId = roomId;
    state.isHost = false;
    state.isSingleplayer = false;
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
    renderLobbyPlayers(state.roomData.players, data.hostId);
    el('lobbyGuestUI').style.display = 'block';
    listenToRoom();
    switchScreen('lobbyScreen');
    showNotice(`Joined room ${roomId}!`, "success", 2500);
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
      
      // Update Lobby UI
      updateLobbyCodeUI(data.id || '');
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
          fragments: state.fragments || []
        };
      } else {
        state.roomData.status = 'studio';
      }
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      try {
        await fb.updateDoc(roomRef, { status: 'studio' });
      } catch(upErr) {
        await fb.setDoc(roomRef, {
          id: state.roomId,
          hostId: state.uid,
          players: state.players || (state.me ? [state.me] : []),
          status: 'studio',
          videoName: state.file?.name || state.roomData?.videoName || '',
          videoSize: state.file?.size || state.roomData?.videoSize || 0,
          scoringMode: state.scoringMode,
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
  el('studioRoomBadge').textContent = state.isSingleplayer ? 'Mode: Solo' : `Room: ${state.roomId}`;
  if (el('studioScoreModeBadge')) {
    el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';
  }
  
  renderStudioPlayerList();
  
  el('editToggleInput').disabled = !state.isHost;
  el('undoBtn').style.display = state.isHost ? 'inline-flex' : 'none';
  el('assignPanel').style.display = state.isSingleplayer ? 'none' : 'flex';
  
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
    // Host auto-segments and distributes lines across players in room
    const initialFrags = autoSegment();
    const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    if(!state.isSingleplayer && roomPlayers.length > 0){
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
    }
  } else {
    // Preserve existing fragments from restored session or room state
    if (existingFrags && existingFrags.length > 0) {
      state.fragments = [...existingFrags];
      if (state.roomData) state.roomData.fragments = [...existingFrags];
      renderMasterCanvas();
      renderFragmentList();
      const myLineIdx = state.fragments.findIndex(f => Array.isArray(f.assigned) && f.assigned.includes(state.uid));
      state.currentIndex = myLineIdx >= 0 ? myLineIdx : 0;
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
  if (lineBadge) {
    lineBadge.textContent = `Line ${state.currentIndex + 1}:`;
  }
  if (!container) return;
  if (f && typeof f.transcript === 'string' && f.transcript.trim()) {
    container.textContent = f.transcript.trim();
    container.style.fontStyle = 'normal';
    container.style.color = '#F5EDFF';
  } else {
    container.textContent = 'Click Voice-to-Text or click to type script...';
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

  const anyTakes = Boolean(state.takes[f.id] && Object.keys(state.takes[f.id]).length > 0);
  el('reviewBtn').disabled = !anyTakes;

  if (!state.isPlaying || state.pb?.mode !== 'record') {
    if (el('recordBtn') && !el('recordBtn').classList.contains('is-armed')) {
      el('recordBtn').innerHTML = `Record Take <span class="key-hint">R</span>`;
    }
  }
}

function selectFragment(idx, skipRedraw = false, isRemote = false){
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
    showNotice(state.editMode ? "Line edit mode enabled. Click anywhere on the timeline to split lines." : "Line edit mode disabled.", "info", 2200);
  };
}

if (el('masterCanvas')) {
  el('masterCanvas').onclick = async (e) => {
    if(state.fragments.length === 0) return showNotice("No dub lines loaded.", "info");
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
          selectFragment(idx, true);
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
    const assignedUids = Array.isArray(frag.assigned) ? frag.assigned : [];
    assignedUids.forEach(uid => {
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

function renderMasterCanvas(){
  const canvas = el('masterCanvas');
  if(!canvas) return;
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
    const isDone = Array.isArray(f.assigned) && f.assigned.length > 0 && f.assigned.every(id => state.takes[f.id] && state.takes[f.id][id]);
    
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

  state.fragments.forEach((f, i) => {
    const isCurrent = (i === state.currentIndex);
    let rowClasses = 'frag-row';
    let activeTagHTML = '';
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
    
    let assignHTML = '';
    const assignedList = Array.isArray(f.assigned) ? f.assigned : [];
    if(assignedList.length === 0){
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

    row.innerHTML = `
      <span class="frag-num">${String(i+1).padStart(2,'0')}</span>
      <div class="frag-info">
        <div class="frag-top-line">
          <div style="display:inline-flex; align-items:center;">
            <span class="frag-time">${f.start.toFixed(1)}s - ${f.end.toFixed(1)}s</span>
            ${activeTagHTML}
          </div>
          <div class="frag-assignees">${assignHTML}</div>
        </div>
        ${liveRecHTML}
      </div>
    `;

    row.onclick = () => selectFragment(i);
    list.appendChild(row);

    if (state.isHost && i < state.fragments.length - 1) {
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
  if(mode === 'paused'){ btn.textContent = 'Resume'; btn.disabled = false; }
  else if(mode === 'playing'){ btn.textContent = 'Pause'; btn.disabled = false; }
  else { btn.textContent = 'Pause'; btn.disabled = true; }
}

function sendPlaybackEvent(event){
  if(state.isSingleplayer || !state.roomId) return;
  multiplayer.api.sendRoomEvent(state.roomId, { ...event, sentAt: event.sentAt || Date.now(), originUid: state.uid, playerName: state.me?.name }).catch(error => {
    console.error('Playback sync error:', error);
  });
}

function handleRoomEvent(event){
  if(!event || event.originUid === state.uid) return;

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

  const mixVol = parseInt(el('mixSlider').value, 10) / 100;
  v.muted = isRemote || mode === 'record';
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
      el('recordBtn').innerHTML = `<span class="rec-dot-pulse" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-right:6px;animation:rec-pulse 0.7s infinite alternate;"></span>Recording... <span class="key-hint">R</span>`;

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
    startReviewSources(pb, pb.sourcesOffsetAtStart || 0);
    el('monitorBadgeText').textContent = "Playing Takes"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('reviewing', pb?.frag?.id, state.currentIndex);
  } else {
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
  el('recordBtn').innerHTML = `Record Take <span class="key-hint">R</span>`;

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
          } else if (wasNormalized) {
            showNotice(`Take leveled to ${normalizedDb} dBFS`, "info", 2000);
          }

          if (settings.get('autoAdvance') && state.currentIndex < state.fragments.length - 1) {
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
  v.pause();
  const pb = state.pb;
  if(pb){
    if(pb.syncTimer) clearInterval(pb.syncTimer);
    pb.sources && pb.sources.forEach(s => { try{ s.stop(); }catch(e){} });
    if(pb.recorder && pb.recorder.state !== 'inactive'){
      try{ pb.recorder.stop(); }catch(e){}
    }
  }
  state.pb = null;
  el('monitorBadgeText').textContent = "Idle"; el('monitorBadge').classList.remove('live');
  el('recordBtn').classList.remove('is-armed');
  el('recordBtn').classList.remove('is-recording');
  el('recordBtn').innerHTML = `Record Take <span class="key-hint">R</span>`;

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

if (el('renderBtn')) {
  el('renderBtn').onclick = async () => {
  const v = el('mainVideo');
  if(!v.captureStream && !v.mozCaptureStream){
    return showNotice("Export is not supported in this browser (captureStream unavailable).", "error");
  }
  if(!state.file && (!v.src || v.src === window.location.href)){
    return showNotice("No video loaded to export.", "warning");
  }
  if(!state.duration || state.duration <= 0){
    return showNotice("Video duration is invalid. Please wait for video to load.", "warning");
  }
  
  stopPlayback();
  const renderBtn = el('renderBtn');
  if (renderBtn) {
    renderBtn.classList.remove('is-success');
    renderBtn.disabled = true;
    renderBtn.textContent = 'Rendering Dub...';
  }
  el('renderProgress').classList.add('show');
  el('downloadLink').classList.remove('show');
  
  let renderStepper = null;
  try {
    const ctx = ensureCtx();
    if(ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    const vStream = typeof v.captureStream === 'function'
      ? v.captureStream()
      : (typeof v.mozCaptureStream === 'function' ? v.mozCaptureStream() : null);
    if (!vStream) {
      throw new Error("Video stream capture is not supported in this browser.");
    }
    const combined = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    
    const mimeOpts = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find(m => {
      try { return MediaRecorder.isTypeSupported(m); } catch(e){ return false; }
    });
    const recorder = new MediaRecorder(combined, mimeOpts ? { mimeType: mimeOpts } : undefined);
    
    const chunks = [];
    recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
    const finished = new Promise(r => recorder.onstop = r);
    
    v.muted = true; v.currentTime = 0;
    await new Promise(r => { v.onseeked = r; setTimeout(r, 300); });
    
    recorder.start();
    const t0 = ctx.currentTime + 0.1;
    const mixVol = parseInt(el('mixSlider').value, 10) / 100;
    let usedFallback = false;
    
    if(state.backgroundBuffer){
      const bgSrc = ctx.createBufferSource();
      bgSrc.buffer = state.backgroundBuffer;
      const bgGain = ctx.createGain();
      bgGain.gain.value = mixVol;
      bgSrc.connect(bgGain); bgGain.connect(dest);
      bgSrc.start(t0);
    } else if(state.masterBuffer){
      usedFallback = true;
      const bgSrc = ctx.createBufferSource();
      bgSrc.buffer = state.masterBuffer;
      const bgGain = ctx.createGain();
      bgGain.gain.value = mixVol;
      bgSrc.connect(bgGain); bgGain.connect(dest);
      bgSrc.start(t0);
    }
    
    const latencySec = (Number(settings.get('micLatencyMs')) || 0) / 1000;
    const isAutoNorm = Boolean(settings.get('autoNormalize'));
    const targetDb = Number(settings.get('targetPeakDb')) || -1.0;
    const silenceFloor = Number(settings.get('silenceThresholdDb')) || -42;

    state.fragments.forEach(f => {
      const takes = state.takes[f.id] || {};
      const assignedWithTakes = (f.assigned || []).filter(uid => takes[uid]);
      if(assignedWithTakes.length > 0){
        assignedWithTakes.forEach(uid => {
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
        if(seg){
          const src = ctx.createBufferSource();
          src.buffer = seg;
          src.connect(dest);
          src.start(t0 + f.start);
        }
      }
    });
    
    await v.play().catch(e => console.warn("Export playback warning:", e));
    const dur = state.duration || 1;
    renderStepper = createProgressStepper({
      fillEl: el('renderProgressFill'),
      initial: 0,
      minStepMs: 5,
      maxStepMs: 14
    });
    const timer = setInterval(() => {
      const pct = Math.min(99, Math.floor((v.currentTime / dur) * 100));
      renderStepper.setTarget(pct);
    }, 50);
    
    await new Promise(r => { v.onended = r; setTimeout(r, dur*1000 + 1000); });
    clearInterval(timer);
    await renderStepper.finish(100);
    if(recorder.state !== 'inactive') recorder.stop();
    await finished;
    
    const isMp4 = mimeOpts && mimeOpts.includes('mp4');
    const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
    el('downloadLink').href = URL.createObjectURL(blob);
    el('downloadLink').download = isMp4 ? 'loop-booth-dub.mp4' : 'loop-booth-dub.webm';
    el('downloadLink').classList.add('show');
    
    // Add success state to renderBtn informing user the file is ready to save
    if (renderBtn) {
      renderBtn.disabled = false;
      renderBtn.classList.add('is-success');
      renderBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:4px;display:inline-block;vertical-align:-2px;">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Ready to Save!
      `;
      setTimeout(() => {
        if (renderBtn && renderBtn.classList.contains('is-success')) {
          renderBtn.classList.remove('is-success');
          renderBtn.textContent = 'Print Final Dub';
        }
      }, 7000);
    }

    // Save completed dub snapshot into persistent Saved Dubs collection
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
      completedLines: state.fragments.filter(f => state.takes[f.id] && Object.keys(state.takes[f.id]).length > 0).length,
      takesCount: Object.values(state.takes).reduce((acc, t) => acc + Object.keys(t).length, 0),
      scoringMode: Boolean(state.scoringMode),
      avgScore,
      audioNormalized: Boolean(settings.get('autoNormalize')),
      exportUrl: el('downloadLink').href,
      fragments: state.fragments
    });
    persistCurrentSession();

    el('renderStatus').textContent = usedFallback
      ? 'Done - mono source, background bed includes original voice.'
      : 'Done - background audio carried through with voice removed.';
    setTimeout(() => el('renderProgress').classList.remove('show'), 1000);
    showNotice("Dub export complete! Your file is ready to save. Click 'Download Final'.", "success", 5000);
  } catch(err) {
    if (renderStepper) renderStepper.stop();
    console.error("Export render error:", err);
    showNotice("Failed to export dub: " + (err?.message || "Render error"), "error");
    if (renderBtn) {
      renderBtn.disabled = false;
      renderBtn.classList.remove('is-success');
      renderBtn.textContent = 'Print Final Dub';
    }
    if (el('renderProgress')) el('renderProgress').classList.remove('show');
  }
  };
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
}


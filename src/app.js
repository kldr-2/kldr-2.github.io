
import { createMultiplayerClient } from './network.js';
import { initAsteroidsBackground, startAsteroids, stopAsteroids, setAsteroidPlayerColors, updateThemeAccent } from './asteroidsBackground.js';

const appId = 'loop-booth-mp';
const multiplayer = createMultiplayerClient();
let auth = null;
let db = multiplayer.db;
let firebaseModules = null;

if (typeof document !== 'undefined') {
  initAsteroidsBackground('bgAsteroids');
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
  backgroundVolume: 0.65,
  
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

  const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>`;
  const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>`;

  function updateThemeButtons(theme) {
    const isLight = theme === 'light';
    const label = isLight ? "Switch to Dark Mode" : "Switch to Light Mode";
    const icon = isLight ? MOON_SVG : SUN_SVG;
    ['themeToggleBtn', 'lobbyThemeToggleBtn', 'studioThemeToggleBtn'].forEach(id => {
      const btn = el(id);
      if (btn) {
        btn.innerHTML = icon;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }
    });
  }

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('loop-booth-theme', theme);
    } catch (_) {}
    updateThemeButtons(theme);
    updateThemeAccent();
    if (state.fragments && state.fragments[state.currentIndex]) {
      drawWave(state.fragments[state.currentIndex]);
    }
    renderMasterCanvas();
  }

  function toggleTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    applyTheme(isLight ? 'dark' : 'light');
  }

  function initTheme() {
    let theme = 'dark';
    try {
      const stored = localStorage.getItem('loop-booth-theme');
      if (stored === 'light' || stored === 'dark') theme = stored;
    } catch (_) {}
    applyTheme(theme);
  }

  if (typeof document !== 'undefined') {
    initTheme();
    ['themeToggleBtn', 'lobbyThemeToggleBtn', 'studioThemeToggleBtn'].forEach(id => {
      const btn = el(id);
      if (btn) {
        btn.onclick = (e) => {
          e.stopPropagation();
          toggleTheme();
        };
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el('confirmModal')?.classList.contains('active')) {
        el('confirmModal').classList.remove('active');
        confirmCallback = null;
        return;
      }

      // Studio shortcuts active only when studio is the current screen
      const studioActive = el('studioScreen')?.classList.contains('active');
      if (!studioActive) return;

      // Don't hijack keys if user is typing in an input or textarea
      const target = e.target;
      const activeEl = document.activeElement;
      const isInput = (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) ||
                      (activeEl && ['INPUT', 'TEXTAREA'].includes(activeEl.tagName)) ||
                      (target && target.isContentEditable) ||
                      (activeEl && activeEl.isContentEditable);
      if (isInput) return;

      // Spacebar: Play / Pause toggle
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();

        if (state.isPlaying) {
          pausePlayback();
          return;
        }
        if (state.paused) {
          resumePlayback();
          return;
        }
        // Idle: play takes if any exist, otherwise listen original
        const f = state.fragments[state.currentIndex];
        if (!f) return;
        const takes = state.takes[f.id] || {};
        if (Object.keys(takes).length > 0) {
          playFragment('review');
        } else {
          playFragment('original');
        }
        return;
      }

      // R key: Record take toggle
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        e.stopPropagation();

        if (state.pb && state.pb.mode === 'record') {
          finishPlayback();
          return;
        }
        const recBtn = el('recordBtn');
        if (recBtn && !recBtn.disabled) {
          recBtn.click();
        } else if (recBtn && recBtn.disabled) {
          showNotice("Assign yourself to this line first to record.", "warning", 2400);
        }
        return;
      }
    });
  }

  const savedDubsBtn = el('savedDubsBtn');
  if (savedDubsBtn) savedDubsBtn.onclick = () => switchScreen('savedDubsScreen');

  const savedDubsBackBtn = el('savedDubsBackBtn');
  if (savedDubsBackBtn) savedDubsBackBtn.onclick = () => switchScreen('setupScreen');

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

  const mixSlider = el('mixSlider');
  if (mixSlider) {
    mixSlider.oninput = () => updateMixSliderDisplay();
    mixSlider.onchange = () => updateMixSliderDisplay();
    updateMixSliderDisplay();
  }
}

function isSoloSession() {
  return Boolean(state.isSingleplayer || !state.roomId || state.roomId === 'LOCAL');
}

function setDropzoneState(status, details = {}) {
  const dropzone = el('hostDropzone');
  const idle = el('dropzoneIdle');
  const loading = el('dropzoneLoading');
  const ready = el('dropzoneReady');
  if (!dropzone) return;

  dropzone.classList.remove('is-uploading', 'is-ready');

  if (status === 'idle') {
    if (idle) idle.style.display = 'flex';
    if (loading) loading.style.display = 'none';
    if (ready) ready.style.display = 'none';
  } else if (status === 'loading') {
    dropzone.classList.add('is-uploading');
    if (idle) idle.style.display = 'none';
    if (loading) loading.style.display = 'flex';
    if (ready) ready.style.display = 'none';

    if (details.title && el('dropzoneLoadingTitle')) {
      el('dropzoneLoadingTitle').textContent = details.title;
    }
    const pct = Math.min(100, Math.max(0, details.progress || 0));
    if (el('hostUploadProgressFill')) {
      el('hostUploadProgressFill').style.width = `${pct}%`;
    }
    if (el('dropzoneLoadingSub')) {
      el('dropzoneLoadingSub').textContent = details.subtitle || `${pct}%`;
    }
  } else if (status === 'ready') {
    dropzone.classList.add('is-ready');
    if (idle) idle.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (ready) ready.style.display = 'flex';

    if (el('dropzoneReadyName')) {
      el('dropzoneReadyName').textContent = details.name || 'video.mp4';
    }
    if (el('dropzoneReadyMeta')) {
      el('dropzoneReadyMeta').textContent = details.meta || 'Ready for studio • Click to replace';
    }
  }
}

function resetToMenu() {
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

  if (el('undoBtn')) el('undoBtn').disabled = true;
  if (el('setupLoader')) el('setupLoader').style.display = 'none';
  if (el('lobbyHostUI')) el('lobbyHostUI').style.display = 'none';
  if (el('lobbyGuestUI')) el('lobbyGuestUI').style.display = 'none';
  if (el('startStudioBtn')) el('startStudioBtn').disabled = true;
  if (el('hostFileInput')) el('hostFileInput').value = '';
  setDropzoneState('idle');
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
  
  setAsteroidPlayerColors([PLAYER_COLORS[0]]);
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
}

function switchScreen(id){
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (el(id)) el(id).classList.add('active');
  }

  startAsteroids();
}

function ensureCtx(){
  if(!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}

async function authenticate(){
  if(state.uid) return true;
  el('setupLoader').style.display = 'block';
  const fb = await loadFirebase();
  if(!fb){ el('setupLoader').style.display = 'none'; return false; }
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
    el('setupLoader').style.display = 'none';
    return false;
  }
}

function renderLobbyPlayers(players, hostId){
  if (Array.isArray(players) && players.length > 0) {
    const colors = players.map(p => p?.color).filter(Boolean);
    setAsteroidPlayerColors(colors);
  }
  if (!Array.isArray(players) || players.length === 0) {
    el('lobbyPlayerList').innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; gap:8px; padding:16px; color:var(--text-dim); font-size:13px;">
        <div class="monitor-spinner" style="width:16px; height:16px; border-width:2px;"></div>
        <span>Waiting for players to join...</span>
      </div>
    `;
    return;
  }
  el('lobbyPlayerList').innerHTML = players.map(player => {
    const progress = Number.isFinite(player.syncProgress) ? player.syncProgress : 0;
    const isSyncing = !player.ready && progress > 0;
    const status = player.ready
      ? 'Ready'
      : isSyncing
        ? `<span>Syncing ${progress}%</span><span class="player-sync-bar"><span style="width:${progress}%"></span></span>`
        : 'Waiting';
    return `
      <div class="player-row">
        <div class="player-swatch" style="background:${player.color}"></div>
        <div class="player-name">${player.name} ${player.id === hostId ? '(Host)' : ''}</div>
        <div class="player-status ${player.ready ? 'ready' : ''}">${status}</div>
      </div>
    `;
  }).join('');
}

if (el('singleplayerBtn')) {
  el('singleplayerBtn').onclick = () => {
    state.isSingleplayer = true;
    state.uid = 'local_player';
    state.isHost = true;
    state.roomId = 'LOCAL';
    state.me = { id: state.uid, name: 'You', color: PLAYER_COLORS[0], ready: true };
    setAsteroidPlayerColors([PLAYER_COLORS[0]]);
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
    
    el('lobbyRoomCode').textContent = 'SOLO';
    el('lobbyPlayerList').innerHTML = `
      <div class="player-row">
        <div class="player-swatch" style="background:${state.me.color}"></div>
        <div class="player-name">You (Solo)</div>
        <div class="player-status ready">Ready</div>
      </div>
    `;
    if(el('scoringToggle')) {
      el('scoringToggle').disabled = false;
      el('scoringToggle').checked = state.scoringMode;
    }
    if(el('scoringHostNote')) el('scoringHostNote').style.display = 'none';
    if(el('scoreModeBadge')) el('scoreModeBadge').classList.toggle('active', state.scoringMode);

    el('lobbyHostUI').style.display = 'block';
    el('lobbyGuestUI').style.display = 'none';
    setDropzoneState('idle');
    el('startStudioBtn').disabled = true; // wait for file
    switchScreen('lobbyScreen');
  };
}

if (el('createRoomBtn')) {
  el('createRoomBtn').onclick = async () => {
    const name = el('playerNameInput')?.value.trim() || 'Host';
    const loader = el('setupLoader');
    const loaderText = el('setupLoaderText');
    if (loader) {
      loader.style.display = 'flex';
      if (loaderText) loaderText.textContent = 'Creating room & connecting...';
    }
    if (el('createRoomBtn')) el('createRoomBtn').disabled = true;
    if (el('joinRoomBtn')) el('joinRoomBtn').disabled = true;

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

      el('lobbyRoomCode').textContent = roomId;
      el('lobbyHostUI').style.display = 'block';
      el('lobbyGuestUI').style.display = 'none';
      setDropzoneState('idle');
      el('startStudioBtn').disabled = true;

      listenToRoom();
      switchScreen('lobbyScreen');
      showNotice(`Room created! Code: ${roomId}`, "success", 3000);
    } catch(err) {
      console.error("Create room error:", err);
      showNotice("Failed to create room: " + (err?.message || "network error"), "error");
    } finally {
      if (loader) loader.style.display = 'none';
      if (el('createRoomBtn')) el('createRoomBtn').disabled = false;
      if (el('joinRoomBtn')) el('joinRoomBtn').disabled = false;
    }
  };
}

if (el('joinRoomBtn')) {
  el('joinRoomBtn').onclick = async () => {
    const name = el('playerNameInput').value.trim() || 'Guest';
    const roomId = el('roomCodeInput').value.trim().toUpperCase();
    if(!roomId) return showNotice("Please enter a room code.", "warning");
    if(roomId.length !== 5) return showNotice("Room code must be 5 letters (e.g. ABCDE).", "warning");

    const loader = el('setupLoader');
    const loaderText = el('setupLoaderText');
    if (loader) {
      loader.style.display = 'flex';
      if (loaderText) loaderText.textContent = `Joining room ${roomId}...`;
    }
    if (el('createRoomBtn')) el('createRoomBtn').disabled = true;
    if (el('joinRoomBtn')) el('joinRoomBtn').disabled = true;

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

      const color = PLAYER_COLORS[data.players.length % PLAYER_COLORS.length];
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

      el('lobbyRoomCode').textContent = data.id;
      renderLobbyPlayers(state.roomData.players, data.hostId);
      el('lobbyHostUI').style.display = 'none';
      el('lobbyGuestUI').style.display = 'block';

      if (data.videoName) {
        if (el('guestWaitContainer')) el('guestWaitContainer').style.display = 'none';
        if (el('guestMatchUI')) el('guestMatchUI').style.display = 'block';
        el('reqFileName').textContent = data.videoName;
      } else {
        if (el('guestWaitContainer')) el('guestWaitContainer').style.display = 'flex';
        if (el('guestMatchUI')) el('guestMatchUI').style.display = 'none';
      }

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
      el('lobbyRoomCode').textContent = data.id;
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
          el('lobbyHostUI').style.display = 'block';
          const allReady = (data.players || []).length > 0 && data.players.every(p => p.ready);
          el('startStudioBtn').disabled = !allReady || !data.videoName;
        } else {
          el('lobbyGuestUI').style.display = 'block';
          if(data.videoName && !state.me.ready){
            el('guestWaitText').style.display = 'none';
            el('guestMatchUI').style.display = 'block';
            el('reqFileName').textContent = data.videoName;
            syncHostVideo(data);
          } else if (state.me.ready) {
            el('guestMatchUI').style.display = 'none';
            el('guestWaitText').style.display = 'block';
            el('guestWaitText').textContent = "File synced! Waiting for host to start...";
          }
        }
      } else if (data.status === 'studio' && !el('studioScreen').classList.contains('active')) {
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
  if (el('guestWaitContainer')) el('guestWaitContainer').style.display = 'none';
  if (el('guestMatchUI')) el('guestMatchUI').style.display = 'block';
  el('reqFileName').textContent = roomData.videoName;
  el('syncProgressFill').style.width = '0%';
  el('syncProgressText').textContent = '0%';
  try {
    state.file = await multiplayer.api.downloadVideo(state.roomId, progress => {
      el('syncProgressFill').style.width = `${progress}%`;
      el('syncProgressText').textContent = `${progress}%`;
      el('guestMatchUI').querySelector('.sync-progress')?.setAttribute('aria-valuenow', progress);
      if(progress === 0 || progress === 100 || progress >= state.syncProgress + 5){
        state.syncProgress = progress;
        multiplayer.api.announcePlayer(state.roomId, { ...state.me, ready:false, syncProgress:progress }).catch(() => {});
      }
    });
    el('syncProgressFill').style.width = '100%';
    el('syncProgressText').textContent = '100% — Ready for studio!';
    state.videoSyncedName = roomData.videoName;
    state.me.ready = true;
    const fb = await loadFirebase();
    if(fb){
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      const updatedPlayers = (state.roomData?.players || []).map(p => p.id === state.uid ? {...p, ready: true, syncProgress: 100} : p);
      state.roomData = { ...state.roomData, players: updatedPlayers };
      await fb.updateDoc(roomRef, { players: updatedPlayers }).catch(() => {});
    }
    await multiplayer.api.announcePlayer(state.roomId, state.me = { ...state.me, ready: true, syncProgress:100 });
  } catch(error) {
    console.error('Host video sync error:', error);
    showNotice('Could not download the host video. Retrying shortly.', 'warning');
    if (el('guestWaitContainer')) el('guestWaitContainer').style.display = 'flex';
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
  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);

  if(isSoloSession()){
    if(state.roomData) state.roomData.videoName = file.name;
    setDropzoneState('ready', {
      name: file.name,
      meta: `${sizeMB} MB • Ready for studio • Click to replace`
    });
    el('startStudioBtn').disabled = false;
    showNotice(`Loaded "${file.name}" for solo session.`, "success", 2500);
    return;
  }

  const fb = await loadFirebase();
  if(!fb) return showNotice("Connection service unavailable. Please retry.", "error");

  try {
    setDropzoneState('loading', {
      title: `Uploading ${file.name}...`,
      progress: 0,
      subtitle: `0% (${sizeMB} MB)`
    });

    await multiplayer.api.uploadVideo(state.roomId, file, (progress) => {
      setDropzoneState('loading', {
        title: `Uploading ${file.name}...`,
        progress,
        subtitle: `${progress}% (${sizeMB} MB)`
      });
    });

    setDropzoneState('ready', {
      name: file.name,
      meta: `${sizeMB} MB • Uploaded & ready for studio • Click to replace`
    });
    el('startStudioBtn').disabled = false;
    showNotice(`Video uploaded! Waiting for guests to sync.`, "success", 3000);
  } catch(error) {
    console.error('Host video upload error:', error);
    state.file = null;
    setDropzoneState('idle');
    el('startStudioBtn').disabled = true;
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

    await fb.updateDoc(roomRef, {
      videoName: file.name,
      videoSize: file.size,
      players: updatedPlayers
    });
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
      el('startStudioBtn').disabled = true;
      el('startStudioBtn').textContent = "Launching Studio...";
      state.roomData.status = 'studio';
      enterStudio();
      return;
    }
    try {
      const fb = await loadFirebase();
      if(!fb) return showNotice("Connection lost. Please refresh.", "error");
      if(!state.file && !state.roomData?.videoName){
        return showNotice("Please upload a video clip before starting the studio.", "warning");
      }
      el('startStudioBtn').disabled = true;
      el('startStudioBtn').textContent = "Launching Studio...";
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      await fb.updateDoc(roomRef, { status: 'studio' });
    } catch(err) {
      console.error("Start studio error:", err);
      el('startStudioBtn').disabled = false;
      el('startStudioBtn').textContent = "Start Studio";
      showNotice("Could not start studio session: " + (err?.message || "network error"), "error");
    }
  };
}

async function enterStudio(){
  if (el('startStudioBtn')) {
    el('startStudioBtn').disabled = false;
    el('startStudioBtn').textContent = "Start Studio";
  }
  switchScreen('studioScreen');
  el('studioRoomBadge').textContent = state.isSingleplayer ? 'Mode: Solo' : `Room: ${state.roomId}`;
  if (el('studioScoreModeBadge')) {
    el('studioScoreModeBadge').style.display = state.scoringMode ? 'inline-flex' : 'none';
  }
  
  renderStudioPlayerList();
  updateMixSliderDisplay();
  
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
    el('monitorLoading').style.display = 'flex';
    el('monitorLoadingText').textContent = 'Syncing video...';
    try {
      state.file = await multiplayer.api.downloadVideo(state.roomId, (progress) => {
        el('monitorLoadingText').textContent = `Syncing video... ${progress}%`;
      });
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
      console.warn('Background download completed via stream fallback:', err);
    } finally {
      el('monitorLoading').style.display = 'none';
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
    el('monitorLoading').style.display = 'flex';
    el('monitorLoadingText').textContent = 'Extracting audio & waveforms...';
    try {
      const ctx = ensureCtx();
      if(ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const arr = await state.file.arrayBuffer();
      state.masterBuffer = await ctx.decodeAudioData(arr.slice(0));
      state.envelope = buildEnvelope(state.masterBuffer, 50);
      state.backgroundBuffer = buildVocalReducedBuffer(state.masterBuffer);
      if(!state.backgroundBuffer){
        showNotice("This clip's audio is mono, so the original voice can't be separated from the background. The full original audio will play under any un-dubbed lines instead.");
      }
    } catch(e) {
      console.warn("Waveform extraction notice:", e);
    } finally {
      el('monitorLoading').style.display = 'none';
    }
  }

  if(state.isHost && (!state.roomData?.fragments || state.roomData.fragments.length === 0)){
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
        await fb.updateDoc(roomRef, { fragments: initialFrags });
        sendPlaybackEvent({ action: 'sync-fragments', fragments: initialFrags });
      }
    }
  } else {
    // If roomData already has fragments or guest joined
    if(state.roomData?.fragments && state.roomData.fragments.length > 0){
      state.fragments = [...state.roomData.fragments];
      renderMasterCanvas();
      renderFragmentList();
      const myLineIdx = state.fragments.findIndex(f => Array.isArray(f.assigned) && f.assigned.includes(state.uid));
      state.currentIndex = myLineIdx >= 0 ? myLineIdx : 0;
      if(state.fragments.length > 0) selectFragment(state.currentIndex, true);
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
    }
    checkRecordAbility();
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

  return refined.map(([s,e], i) => ({ id: 'f_'+i+'_'+Math.random().toString(36).slice(2,6), start: s, end: e, assigned: state.isSingleplayer ? [state.uid] : [] }));
}

function syncFragmentsFromDB(dbFrags){
  if(!Array.isArray(dbFrags) || dbFrags.length === 0) return;
  state.fragments = dbFrags;
  if(state.currentIndex >= state.fragments.length){
    state.currentIndex = Math.max(0, state.fragments.length - 1);
  }
  renderMasterCanvas();
  renderFragmentList();
  const f = state.fragments[state.currentIndex];
  if(f){
    renderAssignmentUI(f);
    checkRecordAbility();
    drawWave(f);
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
            const buffer = await ctx.decodeAudioData(arr);
            
            if(!state.takes[fragId]) state.takes[fragId] = {};
            state.takes[fragId][uid] = { buffer, trace: data.trace, score: data.score };
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

  players.forEach(p => {
    const isAssigned = Array.isArray(frag.assigned) && frag.assigned.includes(p.id);
    const label = document.createElement('label');
    label.className = 'assign-opt';
    label.innerHTML = `
      <input type="checkbox" value="${p.id}" ${isAssigned ? 'checked' : ''}>
      <span style="color:${p.color || '#B285F5'}">${p.name || 'Player'}</span>
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
      const idx = updatedFrags.findIndex(f => f.id === frag.id);
      if(idx > -1){
        updatedFrags[idx].assigned = newAssigned;
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
  if (Array.isArray(players)) {
    const colors = players.map(p => p?.color).filter(Boolean);
    setAsteroidPlayerColors(colors);
  }
  const hostId = state.roomData?.hostId;

  container.innerHTML = players.map(p => {
    const act = state.playerActivities[p.id] || { activity: 'idle' };
    const isMe = p.id === state.uid;
    const isHost = p.id === hostId;

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
      <div class="studio-player-badge ${badgeClass}" data-player-id="${p.id}" data-frag-index="${typeof act.fragIndex === 'number' ? act.fragIndex : ''}" title="Click to view ${p.name}'s active line">
        <div class="p-dot" style="background:${p.color || '#B285F5'}"></div>
        <span class="p-name">${p.name || 'Player'}${youTag}${hostTag}${scoreTag}</span>
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
  
  renderAssignmentUI(f);
  checkRecordAbility();
  
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
        const fb = await loadFirebase();
        if(fb && state.roomId){
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          await fb.updateDoc(roomRef, { fragments: snap.fragments });
        }
      }
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

    const merged = { 
      id: 'f_' + Math.random().toString(36).slice(2,8), 
      start: a.start, 
      end: b.end, 
      assigned: newAssigned 
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
          
          const a = { id: 'f_'+Math.random().toString(36).slice(2,6), start: f.start, end: t, assigned: [...(f.assigned || [])] };
          const b = { id: 'f_'+Math.random().toString(36).slice(2,6), start: t, end: f.end, assigned: [...(f.assigned || [])] };
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
        } catch(err) {
          console.error("Split line error:", err);
          showNotice("Could not split line: " + (err?.message || "error"), "error");
        }
      }
    } else {
      const idx = state.fragments.findIndex(f => t >= f.start && t <= f.end);
      if(idx > -1) selectFragment(idx);
    }
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
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, mid = h/2;
  
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  ctx.fillStyle = isLight ? '#F5EDFD' : '#100C09'; 
  ctx.fillRect(0,0,w,h);
  
  // Original
  const targetEnv = envelopeSlice(frag, Math.round(w));
  ctx.beginPath();
  ctx.strokeStyle = isLight ? '#9D7BE8' : '#5B4A34'; 
  ctx.lineWidth = 1.2;
  for(let x=0; x<w; x++){
    const amp = (targetEnv[x] || 0) * (h*0.42);
    ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();

  // Draw Takes
  if(state.pb && state.pb.mode === 'record'){
    // Live trace (in CSS pixels, same units as w, so it lines up under any dpr)
    ctx.beginPath();
    ctx.strokeStyle = state.me?.color || (isLight ? '#7C3AED' : '#B285F5'); ctx.lineWidth = 1.4;
    for(let x=0; x<state.liveTrace.length; x++){
      const amp = (state.liveTrace[x] || 0) * (h*0.42);
      ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
    }
    ctx.stroke();
  } else {
    // Saved takes
    const takes = state.takes[frag.id] || {};
    const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);
    const assignedUids = Array.isArray(frag.assigned) ? frag.assigned : [];
    assignedUids.forEach(uid => {
      if(takes[uid] && takes[uid].trace){
        const pColor = roomPlayers.find(p => p.id === uid)?.color || (isLight ? '#7C3AED' : '#B285F5');
        ctx.beginPath();
        ctx.strokeStyle = pColor; ctx.lineWidth = 1.4;
        for(let x=0; x<takes[uid].trace.length; x++){
          const amp = (takes[uid].trace[x] || 0) * (h*0.42);
          ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
        }
        ctx.stroke();
      }
    });
  }

  // Playhead
  if(progress > 0){
    const px = progress * w;
    ctx.beginPath(); 
    ctx.strokeStyle = isLight ? '#7C3AED' : 'rgba(243,236,225,0.7)'; 
    ctx.lineWidth = 1.8;
    ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }
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
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0,0,rect.width,rect.height);
  
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  const dur = state.duration || 1;
  state.fragments.forEach((f, i) => {
    const x0 = (f.start/dur) * rect.width, x1 = (f.end/dur) * rect.width;
    const isDone = f.assigned.length > 0 && f.assigned.every(id => state.takes[f.id] && state.takes[f.id][id]);
    
    ctx.fillStyle = isDone 
      ? (isLight ? 'rgba(16,185,129,0.22)' : 'rgba(16,185,129,0.2)') 
      : (isLight ? 'rgba(124,58,237,0.08)' : 'rgba(122,108,92,0.14)');
    ctx.fillRect(x0+1, 2, Math.max(1,x1-x0-2), rect.height-4);
    ctx.strokeStyle = i === state.currentIndex ? '#E8A33D' : (isLight ? '#C4B5FD' : '#3B2F24');
    ctx.lineWidth = i === state.currentIndex ? 2 : 1;
    ctx.strokeRect(x0+1, 2, Math.max(1,x1-x0-2), rect.height-4);
  });
}

function renderFragmentList(){
  const list = el('fragmentList');
  if(!list) return;
  list.innerHTML = '';
  const roomPlayers = state.roomData?.players || (state.me ? [state.me] : []);

  state.fragments.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'frag-row' + (i === state.currentIndex ? ' active' : '');
    
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
        <span class="frag-time">${f.start.toFixed(1)}s - ${f.end.toFixed(1)}s</span>
        <div class="frag-assignees">${assignHTML}</div>
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

function setPauseButton(mode){
  const btn = el('pauseBtn');
  if(!btn) return;
  if(mode === 'paused'){ 
    btn.innerHTML = 'Resume <kbd class="kbd-hint">Space</kbd>'; 
    btn.disabled = false; 
  } else if(mode === 'playing'){ 
    btn.innerHTML = 'Pause <kbd class="kbd-hint">Space</kbd>'; 
    btn.disabled = false; 
  } else { 
    btn.innerHTML = 'Pause <kbd class="kbd-hint">Space</kbd>'; 
    btn.disabled = true; 
  }
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
        const buffer = await ctx.decodeAudioData(arr);
        if(!state.takes[event.fragId]) state.takes[event.fragId] = {};
        state.takes[event.fragId][event.uid] = { buffer, trace: event.trace, score: event.score || 0 };
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

function getMixVolume(){
  const slider = el('mixSlider');
  if(!slider) return (state.backgroundVolume !== undefined ? state.backgroundVolume : 0.65);
  const val = parseFloat(slider.value);
  const normalized = isNaN(val) ? 0.65 : Math.max(0, Math.min(1, val / 100));
  state.backgroundVolume = normalized;
  return normalized;
}

function updateMixSliderDisplay(){
  const slider = el('mixSlider');
  const label = el('mixVal');
  if(!slider) return;
  const vol = getMixVolume();
  if(label) label.textContent = `${Math.round(vol * 100)}%`;
  slider.setAttribute('aria-valuenow', Math.round(vol * 100));
  
  const v = el('mainVideo');
  if(v && (!state.pb || !state.pb.remote)){
    // Update video element volume in real-time whenever not recording
    const isRecording = state.pb && state.pb.mode === 'record';
    const isReviewWithBg = state.pb && state.pb.mode === 'review' && Boolean(state.pb.bgGain);
    
    if(!isRecording && !isReviewWithBg){
      v.muted = (vol < 0.001);
      v.volume = vol;
    }
  }

  // Real-time audio gain adjustment for Web Audio review playback
  if(state.pb && state.isPlaying && !state.paused){
    const ctx = ensureCtx();
    if(state.pb.bgGain){
      state.pb.bgGain.gain.setValueAtTime(vol, ctx.currentTime);
    }
  }
}

function startReviewSources(pb, offsetSeconds){
  const ctx = ensureCtx();
  if(ctx.state === 'suspended') ctx.resume().catch(() => {});
  const takes = state.takes[pb.frag.id] || {};
  pb.sources = [];
  
  // 1. Play recorded takes for this line
  const allTakeUids = new Set([...(pb.frag.assigned || []), ...Object.keys(takes)]);
  allTakeUids.forEach(uid => {
    if(takes[uid] && takes[uid].buffer){
      const src = ctx.createBufferSource();
      src.buffer = takes[uid].buffer;
      src.connect(ctx.destination);
      const safeOffset = Math.max(0, Math.min(offsetSeconds, src.buffer.duration - 0.01));
      src.start(0, safeOffset);
      pb.sources.push(src);
    }
  });

  // 2. Play vocal-reduced background bed under the dub
  const bgBuffer = state.backgroundBuffer || state.masterBuffer;
  const mixVol = getMixVolume();
  const v = el('mainVideo');

  if(bgBuffer && mixVol > 0.001){
    try {
      const bgSrc = ctx.createBufferSource();
      bgSrc.buffer = bgBuffer;
      const bgGain = ctx.createGain();
      bgGain.gain.setValueAtTime(mixVol, ctx.currentTime);
      bgSrc.connect(bgGain).connect(ctx.destination);
      
      const bufferStart = Math.max(0, pb.frag.start + offsetSeconds);
      const remainingDur = Math.max(0.01, pb.frag.end - (pb.frag.start + offsetSeconds));
      
      if(bufferStart < bgBuffer.duration){
        bgSrc.start(0, bufferStart, remainingDur);
        pb.sources.push(bgSrc);
        pb.bgGain = bgGain;
        pb.bgSource = bgSrc;
      }
      if(v) v.muted = true;
    } catch(bgErr) {
      console.warn("Could not start WebAudio background bed, falling back to video audio:", bgErr);
      if(v && !pb.remote){
        v.muted = (mixVol < 0.01);
        v.volume = mixVol;
      }
    }
  } else if(!bgBuffer && v && !pb.remote){
    v.muted = (mixVol < 0.01);
    v.volume = mixVol;
  } else {
    if(v) v.muted = true;
  }

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
  const hasBgBuffer = Boolean(state.backgroundBuffer || state.masterBuffer);
  if (isRemote || mode === 'record') {
    v.muted = true;
    v.volume = 0;
  } else if (mode === 'review') {
    v.muted = hasBgBuffer || (mixVol < 0.001);
    v.volume = mixVol;
  } else {
    // 'original' mode (listening to original clip)
    v.muted = (mixVol < 0.001);
    v.volume = mixVol;
  }
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
      el('recordBtn').innerHTML = 'Stop Take <kbd class="kbd-hint">R</kbd>';
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
    v.muted = isRemote || (mixVol < 0.001);
    v.volume = isRemote ? 0 : mixVol;
    el('monitorBadgeText').textContent = remoteLabel || "Original"; el('monitorBadge').classList.toggle('live', Boolean(remoteLabel));
    if(!isRemote) broadcastMyActivity('listening', f.id, state.currentIndex);
  }

  state.isPlaying = true; state.paused = false;
  setPauseButton('playing');

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
    
    if(pb.mode === 'record' && pb.analyser){
      const data = new Uint8Array(pb.analyser.fftSize);
      pb.analyser.getByteTimeDomainData(data);
      let sum = 0; for(let i=0;i<data.length;i++) sum += Math.pow((data[i]-128)/128, 2);
      const rms = Math.sqrt(sum/data.length);
      const idx = Math.min(state.liveTrace.length-1, Math.floor(progress * state.liveTrace.length));
      state.liveTrace[idx] = Math.min(1, rms * 2.2);
    }
    
    drawWave(f, progress);
    
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
  }
  if(pb.mode === 'review' && pb.sources && pb.sources.length){
    const ctx = ensureCtx();
    const elapsed = ctx.currentTime - pb.sourcesStartedAtCtxTime;
    pb.sourcesOffsetAtStart = pb.sourcesOffsetAtStart + elapsed;
    pb.sources.forEach(s => { try{ s.stop(); }catch(e){} });
    pb.sources = [];
    pb.bgGain = null;
    pb.bgSource = null;
  }
  el('monitorBadgeText').textContent = "Paused"; el('monitorBadge').classList.remove('live');
  setPauseButton('paused');
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
    if(!isRemote) broadcastMyActivity('recording', pb?.frag?.id, state.currentIndex);
  } else if(pb.mode === 'review'){
    startReviewSources(pb, pb.sourcesOffsetAtStart || 0);
    el('monitorBadgeText').textContent = "Playing Takes"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('reviewing', pb?.frag?.id, state.currentIndex);
  } else {
    const vol = getMixVolume();
    v.muted = isRemote || (vol < 0.001);
    v.volume = isRemote ? 0 : vol;
    el('monitorBadgeText').textContent = "Original"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('listening', pb?.frag?.id, state.currentIndex);
  }
  v.playbackRate = 1;
  v.play();
  setPauseButton('playing');
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
  el('recordBtn').innerHTML = 'Record Take <kbd class="kbd-hint">R</kbd>';
  setPauseButton('idle');
  if(!isRemote) broadcastMyActivity('idle');
  
  const pb = state.pb;
  if(pb){
    if(pb.syncTimer) clearInterval(pb.syncTimer);
    pb.sources && pb.sources.forEach(s => { try{ s.stop(); }catch(e){} });
    pb.bgGain = null;
    pb.bgSource = null;
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
          const buffer = await ctx.decodeAudioData(arr);

          let takeScore = 0;
          if (state.scoringMode) {
            takeScore = computeWaveMatchScore(pb.frag, buffer, trace);
          }

          if(!state.takes[fragId]) state.takes[fragId] = {};
          state.takes[fragId][state.uid] = { buffer, trace, score: takeScore };
          renderFragmentList();
          renderMasterCanvas();
          renderStudioPlayerList();
          if(state.fragments[state.currentIndex]?.id === fragId){
            drawWave(state.fragments[state.currentIndex]);
            updateLaneScoreDisplay(state.fragments[state.currentIndex]);
          }
          checkRecordAbility();

          if (state.scoringMode) {
            const tierInfo = getScoreTier(takeScore);
            showNotice(`★ Wave Match: ${takeScore}% (${tierInfo.label})`, tierInfo.toastType, 3600);
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
    pb.bgGain = null;
    pb.bgSource = null;
    if(pb.recorder && pb.recorder.state !== 'inactive'){
      try{ pb.recorder.stop(); }catch(e){}
    }
  }
  state.pb = null;
  el('monitorBadgeText').textContent = "Idle"; el('monitorBadge').classList.remove('live');
  el('recordBtn').classList.remove('is-armed');
  el('recordBtn').innerHTML = 'Record Take <kbd class="kbd-hint">R</kbd>';
  setPauseButton('idle');
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
  el('renderBtn').disabled = true;
  el('renderProgress').classList.add('show');
  el('downloadLink').classList.remove('show');
  
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
    const mixVol = getMixVolume();
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
    
    state.fragments.forEach(f => {
      const takes = state.takes[f.id] || {};
      const assignedWithTakes = (f.assigned || []).filter(uid => takes[uid]);
      if(assignedWithTakes.length > 0){
        assignedWithTakes.forEach(uid => {
          const src = ctx.createBufferSource();
          src.buffer = takes[uid].buffer;
          src.connect(dest);
          src.start(t0 + f.start);
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
    const timer = setInterval(() => {
      el('renderProgressFill').style.width = Math.min(100, (v.currentTime/dur)*100) + '%';
    }, 100);
    
    await new Promise(r => { v.onended = r; setTimeout(r, dur*1000 + 1000); });
    clearInterval(timer); el('renderProgressFill').style.width = '100%';
    if(recorder.state !== 'inactive') recorder.stop();
    await finished;
    
    const isMp4 = mimeOpts && mimeOpts.includes('mp4');
    const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
    el('downloadLink').href = URL.createObjectURL(blob);
    el('downloadLink').download = isMp4 ? 'loop-booth-dub.mp4' : 'loop-booth-dub.webm';
    el('downloadLink').classList.add('show');
    el('renderBtn').disabled = false;
    el('renderStatus').textContent = usedFallback
      ? 'Done - mono source, background bed includes original voice.'
      : 'Done - background audio carried through with voice removed.';
    setTimeout(() => el('renderProgress').classList.remove('show'), 1000);
    showNotice("Dub exported successfully! Click Download.", "success", 3500);
  } catch(err) {
    console.error("Export render error:", err);
    showNotice("Failed to export dub: " + (err?.message || "Render error"), "error");
    if (el('renderBtn')) el('renderBtn').disabled = false;
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


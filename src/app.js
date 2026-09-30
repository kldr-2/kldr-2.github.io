
import { createMultiplayerClient } from './network.js';

const appId = 'loop-booth-mp';
const multiplayer = createMultiplayerClient();
let auth = null;
let db = multiplayer.db;
let firebaseModules = null;

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

const el = (id) => document.getElementById(id);
function showNotice(msg){
  el('noticeText').textContent = msg;
  el('notice').classList.add('show');
  setTimeout(() => el('notice').classList.remove('show'), 5000);
}
el('noticeDismiss').onclick = () => el('notice').classList.remove('show');

let confirmCallback = null;
function showConfirm(title, desc, callback) {
  el('confirmTitle').textContent = title;
  el('confirmDesc').textContent = desc;
  confirmCallback = callback;
  el('confirmModal').classList.add('active');
}
el('confirmCancelBtn').onclick = () => {
  el('confirmModal').classList.remove('active');
  confirmCallback = null;
};
el('confirmOkBtn').onclick = () => {
  el('confirmModal').classList.remove('active');
  if (confirmCallback) confirmCallback();
};

el('savedDubsBtn').onclick = () => switchScreen('savedDubsScreen');
el('savedDubsBackBtn').onclick = () => switchScreen('setupScreen');

function resetToMenu() {
  if (state.unsubRoom) { state.unsubRoom(); state.unsubRoom = null; }
  if (state.unsubTakes) { state.unsubTakes(); state.unsubTakes = null; }
  if (state.roomEventUnsub) { state.roomEventUnsub(); state.roomEventUnsub = null; }
  
  stopPlayback();
  
  if (state.videoURL) { URL.revokeObjectURL(state.videoURL); state.videoURL = null; }
  const video = el('mainVideo');
  video.removeAttribute('src');
  video.load();

  state.roomId = null;
  state.isHost = false;
  state.isSingleplayer = false;
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
  el('undoBtn').disabled = true;
  
  el('setupLoader').style.display = 'none';
  el('lobbyHostUI').style.display = 'none';
  el('lobbyGuestUI').style.display = 'none';
  el('startStudioBtn').disabled = true;
  el('hostFileInput').value = '';
  el('hostDropzone').textContent = 'Click or drop a video file here';
  
  switchScreen('setupScreen');
}

el('lobbyBackBtn').onclick = () => {
  showConfirm('Leave Lobby?', 'Are you sure you want to return to the main menu? You will disconnect from this room.', resetToMenu);
};
el('studioBackBtn').onclick = () => {
  showConfirm('Leave Studio?', 'Are you sure you want to return to the main menu? You will disconnect from this session.', resetToMenu);
};

function switchScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(id).classList.add('active');
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

el('singleplayerBtn').onclick = () => {
  state.isSingleplayer = true;
  state.uid = 'local_player';
  state.isHost = true;
  state.me = { id: state.uid, name: 'You', color: PLAYER_COLORS[0], ready: true };
  state.roomData = {
    id: 'LOCAL',
    hostId: state.uid,
    players: [state.me],
    status: 'lobby',
    videoName: null,
    videoSize: null,
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
  el('lobbyHostUI').style.display = 'block';
  el('startStudioBtn').disabled = true; // wait for file
  switchScreen('lobbyScreen');
};

el('createRoomBtn').onclick = async () => {
  const name = el('playerNameInput').value.trim() || 'Host';
  const ok = await authenticate();
  if(!ok) return;
  const fb = await loadFirebase();
  if(!fb) return;
  
  const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
  state.roomId = roomId;
  state.isHost = true;
  state.me = { id: state.uid, name, color: PLAYER_COLORS[0], ready: false };
  
  const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', roomId);
  await fb.setDoc(roomRef, {
    id: roomId,
    hostId: state.uid,
    players: [state.me],
    status: 'lobby',
    videoName: null,
    videoSize: null,
    fragments: []
  });
  
  listenToRoom();
  switchScreen('lobbyScreen');
  el('setupLoader').style.display = 'none';
};

el('joinRoomBtn').onclick = async () => {
  const name = el('playerNameInput').value.trim() || 'Guest';
  const roomId = el('roomCodeInput').value.trim().toUpperCase();
  if(roomId.length !== 5) return showNotice("Invalid room code format.");
  try {
    const ok = await authenticate();
    if(!ok) return;
    const fb = await loadFirebase();
    if(!fb) return;

    const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', roomId);
    const snap = await fb.getDoc(roomRef);
    if(!snap.exists()) return showNotice("Room not found.");

    const data = snap.data();
    if(data.players.length >= 4) return showNotice("Room is full.");
    if(data.status !== 'lobby') return showNotice("Room already started.");

    const color = PLAYER_COLORS[data.players.length];
    state.me = { id: state.uid, name, color, ready: false };
    state.roomId = roomId;
    state.isHost = false;
    state.roomData = { ...data, players: [...data.players, state.me] };
    el('lobbyRoomCode').textContent = data.id;
    renderLobbyPlayers(state.roomData.players, data.hostId);
    el('lobbyGuestUI').style.display = 'block';
    listenToRoom();
    switchScreen('lobbyScreen');
    multiplayer.api.announcePlayer(state.roomId, state.me).catch(error => {
      console.error('Join room sync error:', error);
      showNotice('Connected to the room, but the player list is still syncing.');
    });
  } catch(error) {
    console.error('Join room error:', error);
    showNotice(error.message || 'Could not join that room.');
  } finally {
    el('setupLoader').style.display = 'none';
  }
};

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
  el('reqFileName').textContent = roomData.videoName;
  el('syncProgressFill').style.width = '0%';
  el('syncProgressText').textContent = '0%';
  try {
    state.file = await multiplayer.api.downloadVideo(state.roomId, progress => {
      el('syncProgressFill').style.width = `${progress}%`;
      el('syncProgressText').textContent = `${progress}%`;
      el('guestMatchUI').querySelector('.sync-progress').setAttribute('aria-valuenow', progress);
      if(progress === 0 || progress === 100 || progress >= state.syncProgress + 5){
        state.syncProgress = progress;
        multiplayer.api.announcePlayer(state.roomId, { ...state.me, ready:false, syncProgress:progress }).catch(() => {});
      }
    });
    el('syncProgressFill').style.width = '100%';
    el('syncProgressText').textContent = '100% - ready';
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
    showNotice('Could not download the host video. Retrying shortly.');
  } finally {
    state.videoSyncing = false;
  }
}

// Host File Selection
el('hostDropzone').onclick = () => el('hostFileInput').click();
el('hostFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  if(!file.type.startsWith('video/')) return showNotice("Must be a video file.");
  
  state.file = file;
  el('hostDropzone').textContent = `Selected: ${file.name}`;
  
  if(state.isSingleplayer){
    state.roomData.videoName = file.name;
    el('startStudioBtn').disabled = false;
    return;
  }
  
  const fb = await loadFirebase();
  if(!fb) return;
  try {
    await multiplayer.api.uploadVideo(state.roomId, file);
  } catch(error) {
    console.error('Host video upload error:', error);
    state.file = null;
    el('hostDropzone').textContent = 'Click or drop a video file here';
    return showNotice('Could not upload the video to the room.');
  }
  const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
  
  // Set host ready
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
  el('hostDropzone').textContent = `Selected: ${file.name}`;
};

el('startStudioBtn').onclick = async () => {
  if (state.isSingleplayer) {
    state.roomData.status = 'studio';
    enterStudio();
    return;
  }
  const fb = await loadFirebase();
  if(!fb) return;
  const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
  await fb.updateDoc(roomRef, { status: 'studio' });
};

async function enterStudio(){
  switchScreen('studioScreen');
  el('studioRoomBadge').textContent = state.isSingleplayer ? 'Mode: Solo' : `Room: ${state.roomId}`;
  
  renderStudioPlayerList();
  
  el('editToggleInput').disabled = !state.isHost;
  el('undoBtn').style.display = state.isHost ? 'inline-flex' : 'none';
  el('assignPanel').style.display = state.isSingleplayer ? 'none' : 'flex';
  
  const video = el('mainVideo');

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
      if(state.fragments[state.currentIndex]){
        drawWave(state.fragments[state.currentIndex]);
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

    return `
      <div class="studio-player-badge ${badgeClass}" data-player-id="${p.id}" data-frag-index="${typeof act.fragIndex === 'number' ? act.fragIndex : ''}" title="Click to view ${p.name}'s active line">
        <div class="p-dot" style="background:${p.color || '#B285F5'}"></div>
        <span class="p-name">${p.name || 'Player'}${youTag}${hostTag}</span>
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

  if(!state.isSingleplayer && state.roomId && !isRemote){
    broadcastMyActivity('idle', f.id, idx);
  }
}

el('prevFragBtn').onclick = () => selectFragment(Math.max(0, state.currentIndex - 1));
el('nextFragBtn').onclick = () => selectFragment(Math.min(state.fragments.length - 1, state.currentIndex + 1));

function saveState() {
  state.undoStack.push({
    fragments: JSON.parse(JSON.stringify(state.fragments)),
    currentIndex: state.currentIndex
  });
  if (state.undoStack.length > 15) state.undoStack.shift();
  if (state.isHost) el('undoBtn').disabled = false;
}

el('undoBtn').onclick = async () => {
  if (!state.isHost || state.undoStack.length === 0) return;
  const snap = state.undoStack.pop();
  if (state.undoStack.length === 0) el('undoBtn').disabled = true;

  if (state.isSingleplayer) {
    state.fragments = snap.fragments;
    state.currentIndex = Math.min(snap.currentIndex, state.fragments.length - 1);
    renderMasterCanvas();
    renderFragmentList();
    if (state.fragments.length > 0) selectFragment(state.currentIndex, true);
  } else {
    const fb = await loadFirebase();
    if(!fb) return;
    const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
    await fb.updateDoc(roomRef, { fragments: snap.fragments });
  }
};

async function mergeWithNext(index) {
  if (!state.isHost || index < 0 || index >= state.fragments.length - 1) return;
  saveState();
  
  const a = state.fragments[index];
  const b = state.fragments[index + 1];
  const assignedSet = new Set([...a.assigned, ...b.assigned]);
  const newAssigned = Array.from(assignedSet).slice(0, 2);

  const merged = { 
    id: 'f_' + Math.random().toString(36).slice(2,8), 
    start: a.start, 
    end: b.end, 
    assigned: newAssigned 
  };
  
  const newFrags = [...state.fragments];
  newFrags.splice(index, 2, merged);
  
  if (state.isSingleplayer) {
    state.fragments = newFrags;
    state.currentIndex = Math.min(state.currentIndex, newFrags.length - 1);
    renderMasterCanvas();
    renderFragmentList();
    selectFragment(state.currentIndex, true);
  } else {
    state.fragments = newFrags;
    state.currentIndex = Math.min(state.currentIndex, newFrags.length - 1);
    renderMasterCanvas();
    renderFragmentList();
    selectFragment(state.currentIndex, true);
    sendPlaybackEvent({ action: 'sync-fragments', fragments: newFrags, activeLineIndex: state.currentIndex });
    const fb = await loadFirebase();
    if(fb){
      const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
      await fb.updateDoc(roomRef, { fragments: newFrags, activeLineIndex: state.currentIndex });
    }
  }
}

// Edit Mode (Host only)
el('editToggleInput').onchange = (e) => {
  if(!state.isHost) return;
  state.editMode = e.target.checked;
  el('editToggle').classList.toggle('on', state.editMode);
};

el('masterCanvas').onclick = async (e) => {
  if(state.fragments.length === 0) return;
  const rect = el('masterCanvas').getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * state.duration;
  
  if(state.editMode && state.isHost){
    const idx = state.fragments.findIndex(f => t > f.start && t < f.end);
    if(idx > -1) {
      const f = state.fragments[idx];
      if(t - f.start < 0.3 || f.end - t < 0.3) return; // Too close
      
      saveState();
      
      const a = { id: 'f_'+Math.random().toString(36).slice(2,6), start: f.start, end: t, assigned: [...f.assigned] };
      const b = { id: 'f_'+Math.random().toString(36).slice(2,6), start: t, end: f.end, assigned: [...f.assigned] };
      const newFrags = [...state.fragments];
      newFrags.splice(idx, 1, a, b);
      
      state.fragments = newFrags;
      renderMasterCanvas();
      renderFragmentList();
      selectFragment(idx, true);
      
      if (!state.isSingleplayer && state.roomId) {
        sendPlaybackEvent({ action: 'sync-fragments', fragments: newFrags, activeLineIndex: idx });
        const fb = await loadFirebase();
        if(fb){
          const roomRef = fb.doc(db, 'artifacts', appId, 'public', 'data', 'rooms', state.roomId);
          await fb.updateDoc(roomRef, { fragments: newFrags, activeLineIndex: idx });
        }
      }
    }
  } else {
    const idx = state.fragments.findIndex(f => t >= f.start && t <= f.end);
    if(idx > -1) selectFragment(idx);
  }
};

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
  
  ctx.fillStyle = '#100C09'; ctx.fillRect(0,0,w,h);
  
  // Original
  const targetEnv = envelopeSlice(frag, Math.round(w));
  ctx.beginPath();
  ctx.strokeStyle = '#5B4A34'; ctx.lineWidth = 1;
  for(let x=0; x<w; x++){
    const amp = (targetEnv[x] || 0) * (h*0.42);
    ctx.moveTo(x, mid - amp); ctx.lineTo(x, mid + amp);
  }
  ctx.stroke();

  // Draw Takes
  if(state.pb && state.pb.mode === 'record'){
    // Live trace (in CSS pixels, same units as w, so it lines up under any dpr)
    ctx.beginPath();
    ctx.strokeStyle = state.me?.color || '#B285F5'; ctx.lineWidth = 1.4;
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
        const pColor = roomPlayers.find(p => p.id === uid)?.color || '#B285F5';
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
    ctx.beginPath(); ctx.strokeStyle = 'rgba(243,236,225,0.6)'; ctx.lineWidth = 1.5;
    ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }
}

function renderMasterCanvas(){
  const canvas = el('masterCanvas');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0,0,rect.width,rect.height);
  
  const dur = state.duration || 1;
  state.fragments.forEach((f, i) => {
    const x0 = (f.start/dur) * rect.width, x1 = (f.end/dur) * rect.width;
    const isDone = f.assigned.length > 0 && f.assigned.every(id => state.takes[f.id] && state.takes[f.id][id]);
    
    ctx.fillStyle = isDone ? 'rgba(16,185,129,0.2)' : 'rgba(122,108,92,0.14)';
    ctx.fillRect(x0+1, 2, Math.max(1,x1-x0-2), rect.height-4);
    ctx.strokeStyle = i === state.currentIndex ? '#E8A33D' : '#3B2F24';
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
        const hasTake = state.takes[f.id] && state.takes[f.id][uid];
        const pName = p ? p.name : (uid === state.uid ? (state.me?.name || 'You') : 'Player');
        const pColor = p ? p.color : '#B285F5';
        assignHTML += `<span class="assignee-chip ${hasTake?'done':''}" title="${pName}${hasTake ? ' - take recorded' : ' - assigned'}" style="--chip-color:${pColor}"><span class="assignee-dot"></span>${pName}</span>`;
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
        if(state.fragments[state.currentIndex]?.id === event.fragId){
          drawWave(state.fragments[state.currentIndex]);
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
      if(!state.micStream) state.micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    }catch(err){
      showNotice("Microphone access was blocked or unavailable - allow microphone access to record a take.");
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
    if(!isRemote) broadcastMyActivity('recording', f.id, state.currentIndex);
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
      }).catch(e => console.warn('Muted playback also blocked:', e));
    } else {
      console.warn('Playback could not start:', error);
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
    el('monitorBadgeText').textContent = "Original"; el('monitorBadge').classList.remove('live');
    if(!isRemote) broadcastMyActivity('listening', pb?.frag?.id, state.currentIndex);
  }
  v.playbackRate = 1;
  v.play();
  setPauseButton('playing');
  runLoop();
  if(!isRemote) sendPlaybackEvent({ action:'resume', fragmentId:pb.frag.id, position:Math.max(0, v.currentTime - pb.frag.start) });
}

el('pauseBtn').onclick = () => {
  if(state.paused) resumePlayback();
  else if(state.isPlaying) pausePlayback();
};

function finishPlayback(isRemote = false){
  state.isPlaying = false; state.paused = false;
  if(state.rafId){ cancelAnimationFrame(state.rafId); state.rafId = null; }
  const v = el('mainVideo');
  v.pause();
  el('monitorBadgeText').textContent = "Idle"; el('monitorBadge').classList.remove('live');
  el('recordBtn').classList.remove('is-armed');
  setPauseButton('idle');
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
          const buffer = await ctx.decodeAudioData(arr);
          if(!state.takes[fragId]) state.takes[fragId] = {};
          state.takes[fragId][state.uid] = { buffer, trace, score: 0 };
          renderFragmentList();
          renderMasterCanvas();
          if(state.fragments[state.currentIndex]?.id === fragId){
            drawWave(state.fragments[state.currentIndex]);
          }
          checkRecordAbility();
        } catch(decErr) {
          console.error("Local take decode error:", decErr);
        }

        if (state.isSingleplayer) return;

        // In multiplayer, send take to peers immediately & save to room storage
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          try {
            const base64 = reader.result;

            sendPlaybackEvent({
              action: 'new-take',
              fragId,
              uid: state.uid,
              audio: base64,
              trace,
              score: 0
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
              score: 0
            });
          } catch (err) {
            console.error("Multiplayer take upload error:", err);
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
  setPauseButton('idle');
  if(!isRemote){
    broadcastMyActivity('idle');
    sendPlaybackEvent({ action:'stop' });
  }
}

el('listenBtn').onclick = () => playFragment('original');
el('recordBtn').onclick = async () => {
  const f = state.fragments[state.currentIndex];
  if(!f) return;
  const assigned = Array.isArray(f.assigned) ? f.assigned : [];
  if(!state.isSingleplayer && !assigned.includes(state.uid)){
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
el('reviewBtn').onclick = () => playFragment('review');

el('renderBtn').onclick = async () => {
  const v = el('mainVideo');
  if(!v.captureStream && !v.mozCaptureStream) return showNotice("Export not supported in this browser.");
  
  stopPlayback();
  el('renderBtn').disabled = true;
  el('renderProgress').classList.add('show');
  el('downloadLink').classList.remove('show');
  
  const ctx = ensureCtx();
  const dest = ctx.createMediaStreamDestination();
  const vStream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  const combined = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  
  const mimeOpts = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find(m => {
    try { return MediaRecorder.isTypeSupported(m); } catch(e){ return false; }
  });
  const recorder = new MediaRecorder(combined, mimeOpts ? { mimeType: mimeOpts } : undefined);
  
  const chunks = [];
  recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
  const finished = new Promise(r => recorder.onstop = r);
  
  v.muted = true; v.currentTime = 0;
  await new Promise(r => { v.onseeked = r; setTimeout(r,300); });
  
  recorder.start();
  const t0 = ctx.currentTime + 0.1;
  const mixVol = parseInt(el('mixSlider').value, 10) / 100;
  let usedFallback = false;
  
  // Continuous background bed: the original clip with its voice cancelled out,
  // so music/ambience keeps playing under the whole dub. Falls back to the
  // plain original (voice included, at the same level) if the source is mono.
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
  
  // Foreground per line: recorded take(s) if present, otherwise fall back to
  // the original full audio for that line so it isn't silent.
  state.fragments.forEach(f => {
    const takes = state.takes[f.id] || {};
    const assignedWithTakes = f.assigned.filter(uid => takes[uid]);
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
  
  v.play();
  const dur = state.duration || 1;
  const timer = setInterval(() => {
    el('renderProgressFill').style.width = Math.min(100, (v.currentTime/dur)*100) + '%';
  }, 100);
  
  await new Promise(r => { v.onended = r; setTimeout(r, dur*1000 + 1000); });
  clearInterval(timer); el('renderProgressFill').style.width = '100%';
  recorder.stop();
  await finished;
  
  const isMp4 = mimeOpts && mimeOpts.includes('mp4');
  const blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
  el('downloadLink').href = URL.createObjectURL(blob);
  el('downloadLink').download = isMp4 ? 'loop-booth-dub.mp4' : 'loop-booth-dub.webm';
  el('downloadLink').classList.add('show');
  el('renderBtn').disabled = false;
  el('renderStatus').textContent = usedFallback
    ? 'Done - mono source, so background bed includes the original voice too.'
    : 'Done - background music/noise carried through with the voice removed.';
  setTimeout(() => el('renderProgress').classList.remove('show'), 1000);
};


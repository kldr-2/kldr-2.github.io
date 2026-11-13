/**
 * Saved Dubs & Active Lobby Store for Loop Booth
 * Manages persistent storage for the last worked lobby/session
 * and all finalized/exported dubs with rich metadata.
 */

const LAST_LOBBY_KEY = 'loop_booth_last_lobby_v1';
const SAVED_DUBS_KEY = 'loop_booth_saved_dubs_v1';

export function formatDateString(timestamp) {
  if (!timestamp) return 'Recent';
  try {
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) {
      return `Today at ${timeStr}`;
    }
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    return `${dateStr} • ${timeStr}`;
  } catch (_) {
    return 'Recent';
  }
}

export function formatDurationMinSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  const tenths = Math.floor((s % 1) * 10);
  return `${m}:${rem.toString().padStart(2, '0')}.${tenths}`;
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extracts participant summary with takes count from state
 */
export function extractCollaborators(players = [], takes = {}, isSingleplayer = false, myUid = null) {
  const result = [];
  const playerList = Array.isArray(players) && players.length ? players : [];

  // Track take counts per participant
  const counts = {};
  for (const fId in takes) {
    const fragTakes = takes[fId] || {};
    for (const uid in fragTakes) {
      counts[uid] = (counts[uid] || 0) + 1;
    }
  }

  if (isSingleplayer || playerList.length === 0) {
    const soloPlayer = playerList[0];
    let soloName = soloPlayer?.name;
    if (!soloName || soloName.startsWith('anon')) {
      soloName = 'Solo Dubber';
    }
    result.push({
      id: myUid || 'solo-user',
      name: soloName,
      color: '#B285F5',
      role: 'Solo Artist',
      takesCount: Object.values(counts).reduce((a, b) => a + b, 0)
    });
    return result;
  }

  playerList.forEach((p, idx) => {
    result.push({
      id: p.id,
      name: p.name || `anon${Math.min(4, idx + 1)}`,
      color: p.color || '#B285F5',
      role: idx === 0 ? 'Host' : 'Dubber',
      takesCount: counts[p.id] || 0
    });
  });

  return result;
}

/**
 * Saves or updates the currently active / last worked lobby session
 */
export function saveLastWorkedLobby(session) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  if (!session) return null;

  try {
    const now = Date.now();
    const existingRaw = window.localStorage.getItem(LAST_LOBBY_KEY);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};

    // Calculate completion metrics
    const totalLines = Array.isArray(session.fragments) ? session.fragments.length : 0;
    let completedLines = 0;
    let totalTakes = 0;
    let scoreSum = 0;
    let scoredTakes = 0;

    const takesMap = session.takes || {};
    for (const fId in takesMap) {
      const fragTakes = takesMap[fId] || {};
      const uids = Object.keys(fragTakes);
      if (uids.length > 0) completedLines++;
      uids.forEach(uid => {
        totalTakes++;
        const t = fragTakes[uid];
        if (t && typeof t.score === 'number' && t.score > 0) {
          scoreSum += t.score;
          scoredTakes++;
        }
      });
    }

    const coverage = totalLines > 0 ? Math.round((completedLines / totalLines) * 100) : 0;
    const avgScore = scoredTakes > 0 ? Math.round(scoreSum / scoredTakes) : null;

    // Build serializable takes preview data (excluding huge decoded AudioBuffers)
    const takesSerializable = {};
    for (const fId in takesMap) {
      takesSerializable[fId] = {};
      for (const uid in takesMap[fId]) {
        const t = takesMap[fId][uid];
        takesSerializable[fId][uid] = {
          uid,
          score: t.score || 0,
          isNormalized: Boolean(t.isNormalized),
          peakDb: t.normalizedPeakDb || null,
          trace: Array.isArray(t.trace) ? t.trace.slice(0, 80) : [], // compact trace preview
          audio: (typeof t.audio === 'string' && t.audio.length < 500000) ? t.audio : null
        };
      }
    }

    const lastLobby = {
      id: `lobby_${session.roomId || 'SOLO'}_${session.createdAt || now}`,
      isLastLobby: true,
      roomId: session.roomId || (session.isSingleplayer ? 'SOLO' : 'LOCAL'),
      isSingleplayer: Boolean(session.isSingleplayer),
      isHost: Boolean(session.isHost),
      title: session.videoName || (session.isSingleplayer ? 'Solo Dubbing Studio' : `Room ${session.roomId} Session`),
      videoName: session.videoName || 'Custom Video Clip',
      videoSize: session.videoSize ? formatFileSize(session.videoSize) : null,
      videoSizeBytes: session.videoSize || 0,
      duration: session.duration || 0,
      createdAt: existing.createdAt || session.createdAt || now,
      updatedAt: now,
      collaborators: extractCollaborators(session.players, takesMap, session.isSingleplayer, session.uid),
      linesCount: totalLines,
      completedLines,
      coveragePercent: coverage,
      takesCount: totalTakes,
      scoringMode: Boolean(session.scoringMode),
      avgScore,
      audioNormalized: Boolean(session.audioNormalized),
      fragments: (session.fragments || []).map(f => ({
        id: f.id,
        start: f.start,
        end: f.end,
        label: f.label || `Line ${f.id}`,
        assigned: f.assigned || [],
        transcript: f.transcript || ''
      })),
      takes: takesSerializable
    };

    window.localStorage.setItem(LAST_LOBBY_KEY, JSON.stringify(lastLobby));
    return lastLobby;
  } catch (err) {
    console.warn("Could not save last worked lobby to storage:", err);
    return null;
  }
}

/**
 * Retrieves the last worked lobby session
 */
export function getLastWorkedLobby() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(LAST_LOBBY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("Error reading last worked lobby:", err);
    return null;
  }
}

/**
 * Saves a completed or exported dub to the saved dubs collection
 */
export function saveCompletedDub(dub) {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(SAVED_DUBS_KEY);
    let list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];

    const now = Date.now();
    const entry = {
      id: dub.id || `dub_${now}_${Math.random().toString(36).substring(2, 6)}`,
      isLastLobby: false,
      isExported: Boolean(dub.isExported),
      roomId: dub.roomId || 'SOLO',
      isSingleplayer: Boolean(dub.isSingleplayer),
      title: dub.title || dub.videoName || 'Loop Booth Dub',
      videoName: dub.videoName || 'Exported Clip',
      videoSize: dub.videoSize || null,
      duration: dub.duration || 0,
      createdAt: dub.createdAt || now,
      updatedAt: now,
      collaborators: dub.collaborators || [],
      linesCount: dub.linesCount || (dub.fragments ? dub.fragments.length : 0),
      completedLines: dub.completedLines || dub.linesCount || 0,
      coveragePercent: dub.coveragePercent || 100,
      takesCount: dub.takesCount || 0,
      scoringMode: Boolean(dub.scoringMode),
      avgScore: dub.avgScore || null,
      audioNormalized: Boolean(dub.audioNormalized),
      exportUrl: dub.exportUrl || null,
      fragments: dub.fragments || []
    };

    // Prepend and limit to recent 15 entries
    list = [entry, ...list.filter(item => item.id !== entry.id)].slice(0, 15);
    window.localStorage.setItem(SAVED_DUBS_KEY, JSON.stringify(list));
    return entry;
  } catch (err) {
    console.warn("Could not save completed dub:", err);
    return null;
  }
}

/**
 * Gets all saved dubs with the Last Worked Lobby ALWAYS at the top
 */
export function getAllSavedDubs() {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const results = [];

  // 1. Top Saved Dub: Last Worked Lobby
  const lastLobby = getLastWorkedLobby();
  if (lastLobby && (lastLobby.linesCount > 0 || lastLobby.takesCount > 0 || lastLobby.videoName)) {
    results.push({ ...lastLobby, isLastLobby: true });
  }

  // 2. Previously finalized dubs
  try {
    const raw = window.localStorage.getItem(SAVED_DUBS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach(dub => {
          // Avoid duplicate with last lobby if identical id
          if (!lastLobby || dub.id !== lastLobby.id) {
            results.push({ ...dub, isLastLobby: false });
          }
        });
      }
    }
  } catch (err) {
    console.warn("Error reading saved dubs:", err);
  }

  return results;
}

/**
 * Deletes a specific saved dub or clears last lobby
 */
export function deleteSavedDub(id) {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const lastLobby = getLastWorkedLobby();
    if (lastLobby && lastLobby.id === id) {
      window.localStorage.removeItem(LAST_LOBBY_KEY);
    }

    const raw = window.localStorage.getItem(SAVED_DUBS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const filtered = list.filter(item => item.id !== id);
        window.localStorage.setItem(SAVED_DUBS_KEY, JSON.stringify(filtered));
      }
    }
    return true;
  } catch (err) {
    console.warn("Error deleting saved dub:", err);
    return false;
  }
}

/**
 * Clears all saved dubs and last worked lobby
 */
export function clearAllSavedDubs() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(LAST_LOBBY_KEY);
    window.localStorage.removeItem(SAVED_DUBS_KEY);
  } catch (err) {
    console.warn("Error clearing saved dubs:", err);
  }
}

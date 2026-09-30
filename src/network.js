function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createMultiplayerClient() {
  let socket = null;
  let socketReadyPromise = null;
  const pendingRequests = new Map();
  const snapshotListeners = new Map(); // path -> Set(callback)
  const roomEventListeners = new Map(); // roomId -> Set(callback)
  const subscribedPaths = new Set();
  let reconnectTimer = null;

  function getWsUrl() {
    if (typeof window === 'undefined' || !window.location) return 'ws://localhost:3000';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }

  function connectSocket() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return Promise.resolve(null);
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return socketReadyPromise;
    }

    socketReadyPromise = new Promise((resolve) => {
      try {
        socket = new WebSocket(getWsUrl());
      } catch (err) {
        console.error('WebSocket connection error:', err);
        scheduleReconnect();
        resolve(null);
        return;
      }

      socket.onopen = () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        // Resubscribe to all active paths
        for (const path of subscribedPaths) {
          rawSend({ op: 'subscribe', path, requestId: makeId() });
        }
        resolve(socket);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleSocketMessage(msg);
        } catch (e) {
          console.warn('Invalid message received from server:', e);
        }
      };

      socket.onerror = (err) => {
        console.warn('WebSocket error:', err);
      };

      socket.onclose = () => {
        socket = null;
        scheduleReconnect();
      };
    });

    return socketReadyPromise;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket().catch(() => {});
    }, 2000);
  }

  function rawSend(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  async function ensureConnected() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      await connectSocket();
    }
    return socket;
  }

  function handleSocketMessage(msg) {
    if (msg.type === 'snapshot') {
      const callbacks = snapshotListeners.get(msg.path);
      if (callbacks) {
        const snap = snapshot(msg.data);
        callbacks.forEach(cb => {
          try { cb(snap); } catch (e) { console.error('Snapshot listener error:', e); }
        });
      }
      return;
    }

    if (msg.type === 'room-event') {
      const callbacks = roomEventListeners.get(msg.roomId);
      if (callbacks) {
        callbacks.forEach(cb => {
          try { cb(msg.event); } catch (e) { console.error('Room event listener error:', e); }
        });
      }
      return;
    }

    if (msg.requestId && pendingRequests.has(msg.requestId)) {
      const { resolve, reject } = pendingRequests.get(msg.requestId);
      pendingRequests.delete(msg.requestId);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.data);
    }
  }

  function snapshot(data) {
    const isArr = Array.isArray(data);
    return {
      exists: () => data !== null && data !== undefined && (!isArr || data.length > 0),
      data: () => (isArr ? data : data || null),
      docChanges: () => (isArr ? data.map(item => ({ type: 'added', doc: { data: () => item } })) : []),
      forEach: (cb) => {
        if (isArr) {
          data.forEach((item, i) => cb({ data: () => item, id: item?.id || String(i) }));
        }
      }
    };
  }

  async function request(op, path, data) {
    await ensureConnected();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      const sent = rawSend({ requestId, op, path, data });
      if (!sent) {
        pendingRequests.delete(requestId);
        reject(new Error('WebSocket not open'));
      }
      // Safety timeout after 12s
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error(`Request timed out: ${op} ${path}`));
        }
      }, 12000);
    });
  }

  // Pre-connect on load
  connectSocket().catch(() => {});

  const api = {
    async signInAnonymously() {
      const uid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      return { user: { uid } };
    },
    async signInWithCustomToken() {
      return api.signInAnonymously();
    },
    doc(_db, ...parts) {
      return parts.join('/');
    },
    collection(_db, ...parts) {
      return parts.join('/');
    },
    async setDoc(ref, data) {
      return request('set', ref, data);
    },
    async updateDoc(ref, data) {
      return request('update', ref, data);
    },
    async getDoc(ref) {
      const data = await request('get', ref);
      return { exists: () => data !== null && data !== undefined, data: () => data };
    },
    uploadVideo(roomId, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/rooms/${roomId}/video`);
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        if (xhr.upload && onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              onProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Video upload failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error uploading video to room'));
        xhr.send(file);
      });
    },
    downloadVideo(roomId, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `/api/rooms/${roomId}/video`);
        xhr.responseType = 'blob';
        if (onProgress) {
          xhr.onprogress = (e) => {
            if (e.lengthComputable) {
              onProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const disposition = xhr.getResponseHeader('Content-Disposition') || '';
            let fileName = 'clip.mp4';
            if (disposition.includes('filename=')) {
              try {
                fileName = decodeURIComponent(disposition.split('filename=')[1].replace(/["']/g, '').trim());
              } catch (_) {
                fileName = 'clip.mp4';
              }
            }
            const blob = xhr.response;
            const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });
            resolve(file);
          } else {
            reject(new Error(`Video download failed with status ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error downloading video from room'));
        xhr.send();
      });
    },
    async announcePlayer(roomId, player) {
      await ensureConnected();
      rawSend({ op: 'player-presence', roomId, player });
    },
    async sendRoomEvent(roomId, event) {
      await ensureConnected();
      rawSend({ op: 'room-event', roomId, event });
    },
    onRoomEvent(roomId, callback) {
      if (!roomEventListeners.has(roomId)) {
        roomEventListeners.set(roomId, new Set());
      }
      roomEventListeners.get(roomId).add(callback);
      // Ensure subscribed to room path so server knows we are active in this room
      const rPath = `artifacts/loop-booth-mp/public/data/rooms/${roomId}`;
      if (!subscribedPaths.has(rPath)) {
        subscribedPaths.add(rPath);
        rawSend({ op: 'subscribe', path: rPath, requestId: makeId() });
      }

      return () => {
        const set = roomEventListeners.get(roomId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) roomEventListeners.delete(roomId);
        }
      };
    },
    onSnapshot(ref, callback, onError) {
      if (!snapshotListeners.has(ref)) {
        snapshotListeners.set(ref, new Set());
      }
      snapshotListeners.get(ref).add(callback);
      subscribedPaths.add(ref);

      // Subscribe and get initial data
      request('subscribe', ref)
        .then(data => {
          callback(snapshot(data));
        })
        .catch(err => {
          if (onError) onError(err);
        });

      return () => {
        const set = snapshotListeners.get(ref);
        if (set) {
          set.delete(callback);
          if (set.size === 0) {
            snapshotListeners.delete(ref);
            subscribedPaths.delete(ref);
            rawSend({ op: 'unsubscribe', path: ref, requestId: makeId() });
          }
        }
      };
    }
  };

  return { api, db: {} };
}

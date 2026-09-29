const socketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createMultiplayerClient() {
  let socket;
  let connected;
  const pending = new Map();
  const listeners = new Map();

  function connect() {
    if (connected) return connected;
    connected = new Promise((resolve, reject) => {
      socket = new WebSocket(socketUrl());
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Unable to connect to multiplayer server')), { once: true });
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') {
          (listeners.get(message.path) || []).forEach(listener => listener(message.data));
          return;
        }
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.data);
      });
      socket.addEventListener('close', () => {
        connected = null;
        listeners.clear();
      });
    });
    return connected;
  }

  function snapshot(data) {
    if (Array.isArray(data)) {
      return {
        docChanges: () => data.map(item => ({ type: 'added', doc: { data: () => item } }))
      };
    }
    return {
      exists: () => data !== null,
      data: () => data
    };
  }

  async function request(op, path, data) {
    await connect();
    const requestId = makeId();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ requestId, op, path, data }));
    });
  }

  const api = {
    async signInAnonymously() {
      return { user: { uid: crypto.randomUUID() } };
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
    setDoc(ref, data) {
      return request('set', ref, data);
    },
    updateDoc(ref, data) {
      return request('update', ref, data);
    },
    async getDoc(ref) {
      const data = await request('get', ref);
      return { exists: () => data !== null, data: () => data };
    },
    onSnapshot(ref, callback, onError) {
      const current = listeners.get(ref) || [];
      const listener = data => callback(snapshot(data));
      listeners.set(ref, [...current, listener]);
      request('subscribe', ref).then(data => callback(snapshot(data))).catch(onError);
      return () => {
        const remaining = (listeners.get(ref) || []).filter(item => item !== listener);
        if (remaining.length) listeners.set(ref, remaining);
        else listeners.delete(ref);
        request('unsubscribe', ref).catch(() => {});
      };
    }
  };

  return { api, db: {} };
}

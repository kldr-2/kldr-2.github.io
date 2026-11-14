/**
 * Authentication & Guest Session State Preparation for Loop Booth
 * Provides guest mode state and scaffolding for future account sign-in.
 */

export const AUTH_MODES = Object.freeze({
  GUEST: 'guest',
  SIGNED_IN: 'signed_in',
});

const AUTH_STORAGE_KEY = 'loop_booth_auth_session_v1';

let currentSession = {
  mode: AUTH_MODES.GUEST,
  email: null,
  displayName: 'Guest',
};

function readStoredSession() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return currentSession;
  }
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return currentSession;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.mode === AUTH_MODES.SIGNED_IN && parsed.email) {
      currentSession = {
        mode: AUTH_MODES.SIGNED_IN,
        email: String(parsed.email),
        displayName: String(parsed.displayName || parsed.email.split('@')[0] || 'Member'),
      };
    } else {
      currentSession = {
        mode: AUTH_MODES.GUEST,
        email: null,
        displayName: 'Guest',
      };
    }
  } catch (_) {
    currentSession = {
      mode: AUTH_MODES.GUEST,
      email: null,
      displayName: 'Guest',
    };
  }
  return currentSession;
}

function writeStoredSession(session) {
  currentSession = session;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch (_) {
    // Ignore storage quota / privacy mode errors cleanly
  }
}

readStoredSession();

export function getAuthSession() {
  return { ...currentSession };
}

export function getAuthMode() {
  return currentSession.mode || AUTH_MODES.GUEST;
}

export function isGuestUser() {
  return getAuthMode() !== AUTH_MODES.SIGNED_IN;
}

export function getAuthDisplayName() {
  return isGuestUser() ? 'Guest' : (currentSession.displayName || 'Member');
}

export function enterGuestMode() {
  const next = {
    mode: AUTH_MODES.GUEST,
    email: null,
    displayName: 'Guest',
  };
  writeStoredSession(next);
  return { ...next };
}

/**
 * Prepared login handler hook for future backend/OAuth account integration.
 * Currently signals that full accounts are not active yet and preserves Guest Mode.
 */
export function submitPreparedLogin({ email = '', password = '', intent = 'signin' } = {}) {
  const trimmedEmail = String(email || '').trim();
  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    return {
      ok: false,
      reason: 'invalid_email',
      message: 'Please enter a valid email address.',
    };
  }
  if (String(password || '').length < 6) {
    return {
      ok: false,
      reason: 'invalid_password',
      message: 'Password must be at least 6 characters.',
    };
  }
  return {
    ok: false,
    reason: 'not_enabled_yet',
    intent,
    message: 'Account sign-in is coming in a future update. Play as Guest in the meantime!',
  };
}

/**
 * Settings Store & Configuration for Loop Booth
 * Handles persistence, defaults, and reactive updates for user preferences,
 * audio auto-normalization, and keyboard shortcuts.
 */

const STORAGE_KEY = 'loop_booth_settings_v1';

export const DEFAULT_HOTKEYS = {
  playPause: 'Space',
  record: 'KeyR',
  listen: 'KeyL',
  pause: 'KeyP',
  prevLine: 'ArrowLeft',
  nextLine: 'ArrowRight',
  undo: 'KeyU',
  editSplits: 'KeyE',
};

export const DEFAULT_SETTINGS = {
  // Shortcuts
  keyboardShortcuts: true,
  showKeyHints: true,
  hotkeys: { ...DEFAULT_HOTKEYS },

  // Audio Normalization
  autoNormalize: true,
  targetPeakDb: -1.0,        // dBFS target peak (-0.5, -1.0, -2.0, -3.0)
  silenceThresholdDb: -42,   // Noise floor threshold in dBFS
  maxBoostDb: 18,            // Max gain boost allowed in dB

  // Recording & Studio Behavior
  micLatencyMs: 0,           // Latency offset in ms (-150 to +150)
  autoAdvance: false,        // Stay on current line after recording by default
  defaultMixVolume: 65,      // Original vocal-reduced background mix (0-100)

  // Visuals & Subtitles
  simpleMode: 'auto',        // 'auto' (on for non-host guests) | true | false
  showSubtitles: true,       // Show active fragment transcript as monitor subtitles during playback
  asteroidsMode: 'glow',     // 'glow' | 'low' | 'off'
  waveformStyle: 'neon',     // 'neon' | 'solid' | 'smooth'
};

export const MODIFIER_ONLY_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
]);

export function validateHotkeyAssignment(targetAction, code, currentHotkeys = DEFAULT_HOTKEYS, opts = {}) {
  if (!targetAction || !(targetAction in DEFAULT_HOTKEYS)) {
    return { valid: false, reason: 'invalid-action', message: 'Unknown hotkey action.' };
  }
  if (!code || typeof code !== 'string') {
    return { valid: false, reason: 'invalid-key', message: 'Invalid key pressed.' };
  }
  if (MODIFIER_ONLY_CODES.has(code)) {
    return { valid: false, reason: 'modifier-only' };
  }
  if (opts.ctrlKey || opts.metaKey || opts.altKey) {
    return {
      valid: false,
      reason: 'modifier-combo',
      message: 'Use a single key without Ctrl, Alt, or Cmd modifiers.',
    };
  }
  if (/^Digit[1-9]$/.test(code) || code === 'KeyS' || code === 'Escape' || opts.key === '?') {
    return {
      valid: false,
      reason: 'reserved',
      message: 'Keys 1–9, S, ?, and Esc are reserved system shortcuts.',
    };
  }

  const normalized = { ...DEFAULT_HOTKEYS, ...(currentHotkeys && typeof currentHotkeys === 'object' ? currentHotkeys : {}) };
  for (const [existingAction, existingCode] of Object.entries(normalized)) {
    if (existingAction !== targetAction && existingCode === code) {
      return {
        valid: false,
        reason: 'conflict',
        conflictAction: existingAction,
        code,
        message: 'Key is already bound to another action.',
      };
    }
  }

  return {
    valid: true,
    code,
    unchanged: normalized[targetAction] === code,
  };
}

export function sanitizeHotkeys(rawHotkeys) {
  const candidate = {
    ...DEFAULT_HOTKEYS,
    ...(rawHotkeys && typeof rawHotkeys === 'object' ? rawHotkeys : {}),
  };
  const usedCodes = new Set();
  const result = {};

  for (const action of Object.keys(DEFAULT_HOTKEYS)) {
    const code = candidate[action];
    const isReserved = /^Digit[1-9]$/.test(code) || code === 'KeyS' || code === 'Escape' || MODIFIER_ONLY_CODES.has(code);
    if (typeof code === 'string' && code && !isReserved && !usedCodes.has(code)) {
      result[action] = code;
      usedCodes.add(code);
    } else if (!usedCodes.has(DEFAULT_HOTKEYS[action])) {
      result[action] = DEFAULT_HOTKEYS[action];
      usedCodes.add(DEFAULT_HOTKEYS[action]);
    }
  }

  // Ensure every action has a unique key if a default was already claimed by another custom action
  const fallbackPool = ['KeyQ', 'KeyW', 'KeyA', 'KeyD', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'];
  for (const action of Object.keys(DEFAULT_HOTKEYS)) {
    if (!result[action]) {
      const free = fallbackPool.find((k) => !usedCodes.has(k));
      if (free) {
        result[action] = free;
        usedCodes.add(free);
      }
    }
  }

  return result;
}

class SettingsManager {
  constructor() {
    this.data = { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_HOTKEYS } };
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          hotkeys: sanitizeHotkeys(parsed.hotkeys),
        };
        if (!parsed.autoAdvanceDefaultUpdatedV123) {
          this.data.autoAdvance = false;
          this.data.autoAdvanceDefaultUpdatedV123 = true;
          this.save();
        }
      } else {
        this.data.autoAdvanceDefaultUpdatedV123 = true;
      }
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
      this.data = { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_HOTKEYS }, autoAdvanceDefaultUpdatedV123: true };
    }
  }

  save() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('Failed to save settings to localStorage:', e);
    }
  }

  get(key) {
    if (key === 'hotkeys') {
      return sanitizeHotkeys(this.data.hotkeys);
    }
    return this.data[key] !== undefined ? this.data[key] : DEFAULT_SETTINGS[key];
  }

  set(key, value) {
    if (key === 'hotkeys') {
      const next = sanitizeHotkeys(value);
      this.data.hotkeys = next;
      this.save();
      this.notify('hotkeys', next);
      return;
    }
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    this.notify(key, value);
  }

  update(partial) {
    let changed = false;
    for (const [k, v] of Object.entries(partial)) {
      if (k === 'hotkeys') {
        this.data.hotkeys = sanitizeHotkeys(v);
        changed = true;
      } else if (this.data[k] !== v) {
        this.data[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.notify('*', this.data);
    }
  }

  reset() {
    this.data = { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_HOTKEYS }, autoAdvanceDefaultUpdatedV123: true };
    this.save();
    this.notify('*', this.data);
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(key, value) {
    for (const listener of this.listeners) {
      try {
        listener(key, value, this.data);
      } catch (e) {
        console.error('Settings listener error:', e);
      }
    }
  }
}

export const settings = new SettingsManager();

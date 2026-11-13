/**
 * Settings Store & Configuration for Loop Booth
 * Handles persistence, defaults, and reactive updates for user preferences,
 * audio auto-normalization, and keyboard shortcuts.
 */

const STORAGE_KEY = 'loop_booth_settings_v1';

export const DEFAULT_SETTINGS = {
  // Shortcuts
  keyboardShortcuts: true,
  showKeyHints: true,

  // Audio Normalization
  autoNormalize: true,
  targetPeakDb: -1.0,        // dBFS target peak (-0.5, -1.0, -2.0, -3.0)
  silenceThresholdDb: -42,   // Noise floor threshold in dBFS
  maxBoostDb: 18,            // Max gain boost allowed in dB

  // Recording & Studio Behavior
  micLatencyMs: 0,           // Latency offset in ms (-150 to +150)
  autoAdvance: true,         // Auto-select next line after recording
  defaultMixVolume: 65,      // Original vocal-reduced background mix (0-100)

  // Visuals & Subtitles
  showSubtitles: true,       // Show active fragment transcript as monitor subtitles during playback
  asteroidsMode: 'glow',     // 'glow' | 'low' | 'off'
  waveformStyle: 'neon',     // 'neon' | 'solid' | 'smooth'
};

class SettingsManager {
  constructor() {
    this.data = { ...DEFAULT_SETTINGS };
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
      this.data = { ...DEFAULT_SETTINGS };
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
    return this.data[key] !== undefined ? this.data[key] : DEFAULT_SETTINGS[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    this.notify(key, value);
  }

  update(partial) {
    let changed = false;
    for (const [k, v] of Object.entries(partial)) {
      if (this.data[k] !== v) {
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
    this.data = { ...DEFAULT_SETTINGS };
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

/**
 * Asteroids Vector Background
 * Floating purple asteroids in the authentic Atari Asteroids art style.
 * Supports dynamic player color highlights when players join the lobby,
 * maintaining purple as the dominant majority even in a full lobby.
 */

let bgCanvas = null;
let bgCtx = null;
let asteroids = [];
let asteroidAnimId = null;
let isStarted = false;
let activePlayerColors = []; // List of non-purple player { hex, rgb }

function hexToRgb(hex) {
  const clean = (hex || '#B285F5').replace('#', '').trim();
  const bigint = parseInt(clean, 16);
  if (Number.isNaN(bigint)) return { r: 178, g: 133, b: 245 };
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

function getAccentRgb() {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { r: 178, g: 133, b: 245 };
  }
  try {
    const accentHex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#B285F5';
    return hexToRgb(accentHex);
  } catch (_) {
    return { r: 178, g: 133, b: 245 };
  }
}

let accentRgb = getAccentRgb();

function isColorDifferentFromPurple(rgb, basePurple) {
  const dr = rgb.r - basePurple.r;
  const dg = rgb.g - basePurple.g;
  const db = rgb.b - basePurple.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) > 55;
}

export function setAsteroidPlayerColors(colors = []) {
  if (!Array.isArray(colors)) colors = [];
  const base = getAccentRgb();
  accentRgb = base;

  const nonPurple = [];
  const seen = new Set();

  for (const c of colors) {
    if (!c || typeof c !== 'string') continue;
    const rgb = hexToRgb(c);
    const key = `${rgb.r},${rgb.g},${rgb.b}`;
    if (isColorDifferentFromPurple(rgb, base) && !seen.has(key)) {
      seen.add(key);
      nonPurple.push({ hex: c, rgb });
    }
  }

  activePlayerColors = nonPurple;
  reassignAsteroidColors();
}

export function updateThemeAccent() {
  accentRgb = getAccentRgb();
  reassignAsteroidColors();
}

function reassignAsteroidColors() {
  if (!asteroids || !asteroids.length) return;
  const base = getAccentRgb();
  accentRgb = base;

  // Reset all asteroids to base purple target first
  for (const a of asteroids) {
    a.targetRgb = { ...base };
  }

  if (activePlayerColors.length === 0) return;

  // Purple must ALWAYS remain the dominant majority even with a full lobby:
  // Non-purple colors combined can take at most 25% of total asteroids (at least 75% purple).
  const maxNonPurple = Math.max(1, Math.floor(asteroids.length * 0.25));
  const perColor = Math.max(1, Math.floor(maxNonPurple / activePlayerColors.length));

  let assigned = 0;
  activePlayerColors.forEach((pColor, cIdx) => {
    for (let k = 0; k < perColor; k++) {
      if (assigned >= maxNonPurple) break;
      // Stably spread across the asteroid array (e.g. index 2, 6, 10...)
      const targetIndex = (cIdx * 4 + k * 2 + 2) % asteroids.length;
      if (asteroids[targetIndex]) {
        asteroids[targetIndex].targetRgb = { ...pColor.rgb };
        assigned++;
      }
    }
  });
}

function makeAsteroidShape(radius) {
  const points = [];
  const n = 7 + Math.floor(Math.random() * 5); // 7–11 vertices, irregular rock silhouette
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const variance = 0.72 + Math.random() * 0.56;
    points.push({ angle, r: radius * variance });
  }
  return points;
}

function getViewportSize() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { w: 1024, h: 768 };
  }
  const w = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0, 320);
  const h = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0, 480);
  return { w, h };
}

function makeAsteroid(w, h, reduceMotion) {
  const radius = 16 + Math.random() * 44;
  const base = getAccentRgb();
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.55 * (reduceMotion ? 0.3 : 1),
    vy: (Math.random() - 0.5) * 0.55 * (reduceMotion ? 0.3 : 1),
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.005 * (reduceMotion ? 0.3 : 1),
    radius,
    shape: makeAsteroidShape(radius),
    opacity: 0.32 + Math.random() * 0.34,
    currentRgb: { ...base },
    targetRgb: { ...base }
  };
}

function resizeBgCanvas() {
  if (!bgCanvas || !bgCtx || typeof window === 'undefined') return;
  const { w, h } = getViewportSize();
  const dpr = window.devicePixelRatio || 1;
  bgCanvas.width = Math.round(w * dpr);
  bgCanvas.height = Math.round(h * dpr);
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function initAsteroids() {
  const { w, h } = getViewportSize();
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = w < 640 ? 9 : 15;
  asteroids = [];
  for (let i = 0; i < count; i++) {
    asteroids.push(makeAsteroid(w, h, reduceMotion));
  }
  reassignAsteroidColors();
}

function drawAsteroid(a) {
  if (!bgCtx) return;
  bgCtx.save();
  bgCtx.translate(a.x, a.y);
  bgCtx.rotate(a.rotation);
  bgCtx.beginPath();
  a.shape.forEach((p, i) => {
    const px = Math.cos(p.angle) * p.r;
    const py = Math.sin(p.angle) * p.r;
    if (i === 0) bgCtx.moveTo(px, py);
    else bgCtx.lineTo(px, py);
  });
  bgCtx.closePath();

  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  const color = a.currentRgb || accentRgb;
  const r = Math.round(color.r);
  const g = Math.round(color.g);
  const b = Math.round(color.b);

  const strokeAlpha = isLight ? Math.min(0.85, a.opacity * 1.3) : a.opacity;
  bgCtx.strokeStyle = `rgba(${r},${g},${b},${strokeAlpha})`;
  bgCtx.lineWidth = isLight ? 2.0 : 1.7;
  bgCtx.shadowColor = isLight ? `rgba(${r},${g},${b},0.35)` : `rgba(${r},${g},${b},0.65)`;
  bgCtx.shadowBlur = isLight ? 5 : 9;
  bgCtx.stroke();
  bgCtx.restore();
}

function updateAsteroid(a, w, h) {
  a.x += a.vx;
  a.y += a.vy;
  a.rotation += a.rotSpeed;
  const pad = a.radius + 20;
  if (a.x < -pad) a.x = w + pad;
  if (a.x > w + pad) a.x = -pad;
  if (a.y < -pad) a.y = h + pad;
  if (a.y > h + pad) a.y = -pad;

  // Smooth color morphing
  if (a.currentRgb && a.targetRgb) {
    a.currentRgb.r += (a.targetRgb.r - a.currentRgb.r) * 0.04;
    a.currentRgb.g += (a.targetRgb.g - a.currentRgb.g) * 0.04;
    a.currentRgb.b += (a.targetRgb.b - a.currentRgb.b) * 0.04;
  }
}

function asteroidFrame() {
  if (!bgCtx) return;
  const { w, h } = getViewportSize();
  bgCtx.clearRect(0, 0, w, h);
  asteroids.forEach(a => {
    updateAsteroid(a, w, h);
    drawAsteroid(a);
  });
  asteroidAnimId = requestAnimationFrame(asteroidFrame);
}

export function startAsteroids() {
  if (!bgCanvas || !bgCtx || asteroidAnimId) return;
  isStarted = true;
  bgCanvas.style.display = 'block';
  bgCanvas.style.opacity = '1';
  asteroidFrame();
}

export function stopAsteroids() {
  isStarted = false;
  if (asteroidAnimId) {
    cancelAnimationFrame(asteroidAnimId);
    asteroidAnimId = null;
  }
  if (bgCanvas) {
    bgCanvas.style.opacity = '0';
    setTimeout(() => {
      if (!isStarted && bgCanvas) {
        bgCanvas.style.display = 'none';
      }
    }, 400);
  }
}

export function initAsteroidsBackground(canvasId = 'bgAsteroids') {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { start: startAsteroids, stop: stopAsteroids, setPlayerColors: setAsteroidPlayerColors };
  }

  bgCanvas = document.getElementById(canvasId);
  if (!bgCanvas) return { start: startAsteroids, stop: stopAsteroids, setPlayerColors: setAsteroidPlayerColors };

  bgCtx = bgCanvas.getContext('2d');
  if (!bgCtx) return { start: startAsteroids, stop: stopAsteroids, setPlayerColors: setAsteroidPlayerColors };

  accentRgb = getAccentRgb();
  resizeBgCanvas();
  initAsteroids();

  window.addEventListener('resize', () => {
    accentRgb = getAccentRgb();
    resizeBgCanvas();
    initAsteroids();
  });

  // Re-measure after initial layout pass for iframes/embedded hosts
  [50, 300, 1000].forEach(delay => {
    setTimeout(() => {
      resizeBgCanvas();
      initAsteroids();
    }, delay);
  });

  startAsteroids();

  return {
    start: startAsteroids,
    stop: stopAsteroids,
    setPlayerColors: setAsteroidPlayerColors
  };
}

/**
 * Purple Asteroids Vector Background
 * Floating purple asteroids in the authentic Atari Asteroids art style.
 * Uses irregular polygonal wireframes, glow, toroidal edge wrapping,
 * and z-index positioning for embedded iframe resilience.
 */

let bgCanvas = null;
let bgCtx = null;
let asteroids = [];
let asteroidAnimId = null;
let isStarted = false;
let activePlayerColorHexes = [];

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

/**
 * Assigns target RGB colors across `count` asteroids:
 * - Each joined non-purple player receives at most 20% (`Math.floor(count * 0.20)`).
 * - At least 40% always remains the base purple accent color.
 * - Full 4-player lobby => 40% purple, 20% + 20% + 20% (60% split across the 3 other colors).
 */
export function computeAsteroidColorAssignments(count, playerHexColors = [], baseRgb = accentRgb) {
  const total = Math.max(0, Number(count) || 0);
  const assignments = new Array(total).fill(null).map(() => ({ ...baseRgb }));
  if (total === 0 || !Array.isArray(playerHexColors) || playerHexColors.length === 0) {
    return assignments;
  }

  const maxPerPlayer = Math.floor(total * 0.20);
  const maxColoredTotal = Math.floor(total * 0.60);
  if (maxPerPlayer <= 0 || maxColoredTotal <= 0) {
    return assignments;
  }

  const palette = playerHexColors.slice(0, 3).map(hexToRgb);
  // Modulo-5 slot layout interleaves colored asteroids evenly while reserving slots 0 and 2 (40%) for purple
  const slotModuloOrder = [1, 3, 4];
  const countsPerSlot = new Array(palette.length).fill(0);
  let totalColored = 0;

  for (let i = 0; i < total && totalColored < maxColoredTotal; i++) {
    const mod = i % 5;
    const slotIdx = slotModuloOrder.indexOf(mod);
    if (slotIdx !== -1 && slotIdx < palette.length && countsPerSlot[slotIdx] < maxPerPlayer) {
      assignments[i] = { ...palette[slotIdx] };
      countsPerSlot[slotIdx]++;
      totalColored++;
    }
  }

  return assignments;
}

function applyColorsToExistingAsteroids(snapImmediate = false) {
  if (!asteroids || asteroids.length === 0) return;
  const targets = computeAsteroidColorAssignments(asteroids.length, activePlayerColorHexes, accentRgb);
  asteroids.forEach((a, idx) => {
    const t = targets[idx] || accentRgb;
    a.targetRgb = { ...t };
    if (snapImmediate || !a.rgb) {
      a.rgb = { ...t };
    }
  });
}

export function setAsteroidPlayerColors(playerHexColors = []) {
  const cleaned = Array.isArray(playerHexColors)
    ? playerHexColors.filter((c) => typeof c === 'string' && c.trim().length > 0)
    : [];
  const nextKey = cleaned.join(',').toLowerCase();
  const prevKey = activePlayerColorHexes.join(',').toLowerCase();
  if (nextKey === prevKey) return;
  activePlayerColorHexes = cleaned;
  applyColorsToExistingAsteroids(false);
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
    rgb: { ...accentRgb },
    targetRgb: { ...accentRgb },
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
  const count = w < 640 ? 10 : 15;
  asteroids = [];
  for (let i = 0; i < count; i++) {
    asteroids.push(makeAsteroid(w, h, reduceMotion));
  }
  applyColorsToExistingAsteroids(true);
}

function drawAsteroid(a) {
  if (!bgCtx) return;
  const c = a.rgb || accentRgb;
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
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
  bgCtx.strokeStyle = `rgba(${r},${g},${b},${a.opacity})`;
  bgCtx.lineWidth = 1.7;
  bgCtx.shadowColor = `rgba(${r},${g},${b},0.6)`;
  bgCtx.shadowBlur = 9;
  bgCtx.stroke();
  bgCtx.restore();
}

function updateAsteroid(a, w, h) {
  a.x += a.vx;
  a.y += a.vy;
  a.rotation += a.rotSpeed;
  if (a.rgb && a.targetRgb) {
    const ease = 0.06;
    a.rgb.r += (a.targetRgb.r - a.rgb.r) * ease;
    a.rgb.g += (a.targetRgb.g - a.rgb.g) * ease;
    a.rgb.b += (a.targetRgb.b - a.rgb.b) * ease;
  }
  const pad = a.radius + 20;
  if (a.x < -pad) a.x = w + pad;
  if (a.x > w + pad) a.x = -pad;
  if (a.y < -pad) a.y = h + pad;
  if (a.y > h + pad) a.y = -pad;
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

let currentMode = 'glow';
let hideTimeoutId = null;

export function setAsteroidsMode(mode) {
  currentMode = mode || 'glow';
  if (currentMode === 'off') {
    stopAsteroids();
    if (bgCanvas) bgCanvas.style.display = 'none';
  } else {
    if (bgCanvas) {
      bgCanvas.style.display = 'block';
      bgCanvas.style.opacity = currentMode === 'low' ? '0.5' : '1';
    }
    if (typeof document !== 'undefined') {
      const activeScreen = document.querySelector('.screen.active');
      if (activeScreen) {
        startAsteroids();
      }
    }
  }
}

export function startAsteroids() {
  if (currentMode === 'off') {
    if (bgCanvas) bgCanvas.style.display = 'none';
    return;
  }
  if (!bgCanvas || !bgCtx) return;

  if (hideTimeoutId) {
    clearTimeout(hideTimeoutId);
    hideTimeoutId = null;
  }

  isStarted = true;
  bgCanvas.style.display = 'block';
  bgCanvas.style.opacity = currentMode === 'low' ? '0.5' : '1';
  accentRgb = getAccentRgb();
  applyColorsToExistingAsteroids(false);
  resizeBgCanvas();

  if (!asteroidAnimId) {
    asteroidFrame();
  }
}

export function stopAsteroids() {
  isStarted = false;
  if (asteroidAnimId) {
    cancelAnimationFrame(asteroidAnimId);
    asteroidAnimId = null;
  }
  if (hideTimeoutId) {
    clearTimeout(hideTimeoutId);
    hideTimeoutId = null;
  }
  if (bgCanvas) {
    bgCanvas.style.opacity = '0';
    // Hide display after fade to guarantee 0 paint cost in studio
    hideTimeoutId = setTimeout(() => {
      if (!isStarted && bgCanvas) {
        bgCanvas.style.display = 'none';
      }
      hideTimeoutId = null;
    }, 400);
  }
}

export function initAsteroidsBackground(canvasId = 'bgAsteroids') {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { start: startAsteroids, stop: stopAsteroids, setMode: setAsteroidsMode, setPlayerColors: setAsteroidPlayerColors };
  }

  bgCanvas = document.getElementById(canvasId);
  if (!bgCanvas) return { start: startAsteroids, stop: stopAsteroids, setMode: setAsteroidsMode, setPlayerColors: setAsteroidPlayerColors };

  bgCtx = bgCanvas.getContext('2d');
  if (!bgCtx) return { start: startAsteroids, stop: stopAsteroids, setMode: setAsteroidsMode, setPlayerColors: setAsteroidPlayerColors };

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
    setMode: setAsteroidsMode,
    setPlayerColors: setAsteroidPlayerColors
  };
}

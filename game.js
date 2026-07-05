'use strict';
// ═══════════════════════════════════════════════════════════
// БЕСКОНЕЧНЫЙ СБОРЩИК v4 — оптимизированная версия
// ═══════════════════════════════════════════════════════════

// ── Константы ────────────────────────────────────────────────
const TILE       = 48;
const PLAYER_R   = 18;
const SPEED      = 220;
const MAP_W      = 150;
const MAP_H      = 150;
const WORLD_W    = MAP_W * TILE;
const WORLD_H    = MAP_H * TILE;
const REGROW_MS  = 12_000;
const STAGES     = 5;
const STAGE_MS   = REGROW_MS / STAGES;
const CAM_LERP   = 0.10;
const TRACK_LIFE = 5_000;
const TRACK_MS   = 60;

// Кол-во стеблей на стадию (меньше = быстрее)
const BLADE_COUNT  = [0, 4, 7, 10, 13, 16];
const BLADE_HEIGHT = [0, 0.20, 0.40, 0.60, 0.80, 1.0];

// ── DOM ──────────────────────────────────────────────────────
const canvas       = document.getElementById('game-canvas');
const ctx          = canvas.getContext('2d');
const coinEl       = document.getElementById('coin-count');
const speedFillEl  = document.getElementById('speed-fill');
const joystickZone = document.getElementById('joystick-zone');
const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');

// ── Состояние ────────────────────────────────────────────────
let coins   = 0;
let canvasW = 0;
let canvasH = 0;
let dpr     = 1;
let wScale  = 1;

const player = {
  x: WORLD_W / 2,  y: WORLD_H / 2,
  vx: 0,           vy: 0,
  angle: 0,        targetAngle: 0,
  wheelAngle: 0,
  bobPhase: 0,
  jx: 0, jy: 0,   // текущий джиттер
  jTimer: 0,       // таймер смены джиттера
};

const camera = { x: WORLD_W / 2, y: WORLD_H / 2 };

// ── Карта тайлов ─────────────────────────────────────────────
// Каждый тайл: { stage, cutAt, groundColor, blades: [{bxR,byR,bh,lean,hue,sat,lit,lw}] }
const tiles = new Map();

// ── Следы шин ────────────────────────────────────────────────
const tracks = [];
let lastTrackTime = 0;

// ── Ввод ─────────────────────────────────────────────────────
const keys = {};
let mouseTarget = null, mouseActive = false;
const joystick = { active: false, id: -1, baseX: 0, baseY: 0, dx: 0, dy: 0 };

window.addEventListener('keydown', e => { keys[e.key] = true;  mouseActive = false; });
window.addEventListener('keyup',   e => { keys[e.key] = false; });
canvas.addEventListener('mousemove', e => { if (mouseActive) mouseTarget = screenToWorld(e.clientX, e.clientY); });
canvas.addEventListener('mousedown', e => { if (e.button === 0) { mouseActive = true; mouseTarget = screenToWorld(e.clientX, e.clientY); }});
canvas.addEventListener('mouseup',   e => { if (e.button === 0) mouseActive = false; });
canvas.addEventListener('mouseleave',()  => { mouseActive = false; });

joystickBase.addEventListener('touchstart', e => {
  e.preventDefault();
  const t = e.changedTouches[0];
  const r = joystickBase.getBoundingClientRect();
  joystick.active = true; joystick.id = t.identifier;
  joystick.baseX = r.left + r.width/2; joystick.baseY = r.top + r.height/2;
  moveJoystick(t.clientX, t.clientY);
}, { passive: false });
window.addEventListener('touchmove', e => {
  for (const t of e.changedTouches)
    if (t.identifier === joystick.id) { e.preventDefault(); moveJoystick(t.clientX, t.clientY); }
}, { passive: false });
window.addEventListener('touchend', e => {
  for (const t of e.changedTouches)
    if (t.identifier === joystick.id) { joystick.active = false; joystick.dx = joystick.dy = 0; joystickKnob.style.transform = 'translate(-50%,-50%)'; }
});

function moveJoystick(cx, cy) {
  const maxR = joystickBase.offsetWidth / 2;
  let dx = cx - joystick.baseX, dy = cy - joystick.baseY;
  const d = Math.sqrt(dx*dx + dy*dy);
  if (d > maxR) { dx = dx/d*maxR; dy = dy/d*maxR; }
  joystick.dx = dx / maxR; joystick.dy = dy / maxR;
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

// ── Утилиты ──────────────────────────────────────────────────
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * wScale + canvasW/2, y: (wy - camera.y) * wScale + canvasH/2 };
}
function screenToWorld(sx, sy) {
  return { x: (sx - canvasW/2) / wScale + camera.x, y: (sy - canvasH/2) / wScale + camera.y };
}

// Быстрый детерминированный хэш [0,1)
function h01(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// Плавный биварный шум (интерполяция на сетке с шагом STEP тайлов)
function smoothH(gx, gy, seed, STEP) {
  const bx = Math.floor(gx / STEP), by = Math.floor(gy / STEP);
  const tx = (gx - bx*STEP) / STEP, ty = (gy - by*STEP) / STEP;
  const sx = tx*tx*(3-2*tx), sy = ty*ty*(3-2*ty);
  return h01(bx,by,seed)*(1-sx)*(1-sy) + h01(bx+1,by,seed)*sx*(1-sy)
       + h01(bx,by+1,seed)*(1-sx)*sy   + h01(bx+1,by+1,seed)*sx*sy;
}

function tileKey(gx, gy)  { return `${gx}:${gy}`; }
function isForest(gx, gy) { return gx < 0 || gy < 0 || gx >= MAP_W || gy >= MAP_H; }

// ── Кэш визуальных данных тайла ──────────────────────────────
// Рассчитывается один раз при первом обращении, хранится в объекте тайла.
function buildTileVisual(gx, gy) {
  // Плавный цвет земли (groundColor кэшируется)
  const hv  = smoothH(gx, gy, 0, 6);
  const sv  = smoothH(gx, gy, 3, 5);
  const lv  = smoothH(gx, gy, 7, 4);
  const groundH = 90  + hv * 22;
  const groundS = 36  + sv * 22;
  const groundL = 10  + lv * 10;
  const groundColor = `hsl(${groundH},${groundS}%,${groundL}%)`;

  // Цвет стеблей для этого тайла
  const bladeHue = 86 + smoothH(gx, gy, 1, 7) * 28;
  const bladeSat = 40 + smoothH(gx, gy, 4, 6) * 30;
  const bladeLit = 20 + smoothH(gx, gy, 8, 5) * 22;

  // Позиции стеблей: генерируем MAX_STAGE позиций один раз и кэшируем
  const maxCount = BLADE_COUNT[STAGES];
  const blades = [];
  let hh = (Math.imul(gx, 374761393) + Math.imul(gy, 668265263) + 20123) | 0;
  function nextR() {
    hh = Math.imul(hh ^ (hh >>> 13), 1274126177) ^ (hh >>> 16);
    return (hh >>> 0) / 4294967296;
  }
  for (let i = 0; i < maxCount; i++) {
    const rx = nextR(), ry = nextR(), rh = nextR(), ra = nextR(), rc = nextR(), rv = nextR();
    // Позиция основания — в расширенной зоне тайла (overshoot 20%)
    const bxR = (rx - 0.1) * 1.2;  // [−0.12 … 1.08] от левого края тайла
    const byRbase = 0.60 + ry * 0.42; // нижние 40% тайла
    const bhR  = BLADE_HEIGHT[STAGES] * (0.35 + rh * 0.65); // доля от ts
    const lean = (ra - 0.5) * 0.80;
    const hue  = bladeHue + rc * 18 - 9;
    const sat  = bladeSat + rc * 14 - 5;
    const lit  = bladeLit + rc * 16 - 6;
    const lw   = 0.024 + rv * 0.028; // доля от ts
    blades.push({ bxR, byRbase, bhR, lean, hue, sat, lit, lw });
  }

  return { groundColor, blades };
}

function getTile(gx, gy) {
  const k = tileKey(gx, gy);
  if (!tiles.has(k)) {
    const vis = buildTileVisual(gx, gy);
    tiles.set(k, { cutAt: null, stage: STAGES, ...vis });
  }
  return tiles.get(k);
}

// ── Resize ───────────────────────────────────────────────────
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasW = window.innerWidth; canvasH = window.innerHeight;
  canvas.width  = canvasW * dpr; canvas.height = canvasH * dpr;
  canvas.style.width  = canvasW + 'px'; canvas.style.height = canvasH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wScale = clamp(Math.min(canvasW, canvasH) / 480, 0.55, 1.6);
}

function detectTouch() {
  joystickZone.style.display = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) ? 'block' : 'none';
}

// ── HUD / монеты ─────────────────────────────────────────────
function addCoin(sx, sy) {
  coins++; coinEl.textContent = coins;
  coinEl.classList.remove('bump');
  requestAnimationFrame(() => coinEl.classList.add('bump'));
  setTimeout(() => coinEl.classList.remove('bump'), 200);
  const el = document.createElement('div');
  el.className = 'coin-popup'; el.textContent = '+1 🪙';
  el.style.left = `${sx - 18}px`; el.style.top = `${sy - 20}px`;
  document.getElementById('app').appendChild(el);
  setTimeout(() => el.remove(), 920);
}

// ════════════════════════════════════════════════════════════
// ОТРИСОВКА — ЗЕМЛЯ
// ════════════════════════════════════════════════════════════
function drawGround(gxMin, gxMax, gyMin, gyMax) {
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      const { x: sx, y: sy } = worldToScreen(gx * TILE, gy * TILE);
      const ts = TILE * wScale + 1.5;

      if (isForest(gx, gy)) {
        // Лес — тёмная земля
        const v = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 99);
        ctx.fillStyle = `hsl(${108 + v*18},${30 + v*14}%,${8 + v*5}%)`;
      } else {
        const tile = getTile(gx, gy);
        if (tile.stage === 0) {
          // Голая срезанная земля
          const v = h01(gx, gy, 77);
          ctx.fillStyle = `hsl(${24 + v*10},${28 + v*14}%,${13 + v*7}%)`;
        } else {
          ctx.fillStyle = tile.groundColor;
        }
      }
      ctx.fillRect(sx, sy, ts, ts);
    }
  }
}

// ════════════════════════════════════════════════════════════
// ОТРИСОВКА — ТРАВА (из кэша, перекрывающиеся стебли)
// ════════════════════════════════════════════════════════════
function drawGrass(gxMin, gxMax, gyMin, gyMax) {
  ctx.lineCap = 'round';
  for (let gy = gyMin; gy <= gyMax; gy++) {
    for (let gx = gxMin; gx <= gxMax; gx++) {
      if (isForest(gx, gy)) continue;
      const tile  = getTile(gx, gy);
      const stage = tile.stage;
      if (stage === 0) continue;

      const { x: sx, y: sy } = worldToScreen(gx * TILE, gy * TILE);
      const ts    = TILE * wScale;
      const count = BLADE_COUNT[stage];
      const maxH  = BLADE_HEIGHT[stage];

      for (let i = 0; i < count; i++) {
        const b = tile.blades[i];
        // Масштабируем кэшированные относительные координаты
        const bx  = sx + b.bxR * ts;
        const by  = sy + b.byRbase * ts;
        const bh  = ts * maxH * (0.35 + b.bhR / BLADE_HEIGHT[STAGES] * 0.65);
        const lw  = Math.max(0.7, b.lw * ts);
        const tipX = bx + Math.sin(b.lean) * bh;
        const tipY = by - bh;
        const cpX  = bx + Math.sin(b.lean) * bh * 0.48;
        const cpY  = by - bh * 0.58;

        ctx.strokeStyle = `hsl(${b.hue},${b.sat}%,${b.lit}%)`;
        ctx.lineWidth   = lw;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(cpX, cpY, tipX, tipY);
        ctx.stroke();
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// ОТРИСОВКА — ЛЕС (деревья по границе карты)
// ════════════════════════════════════════════════════════════
function drawForest(gxMin, gxMax, gyMin, gyMax) {
  // Низкая лесная трава
  ctx.lineCap = 'round';
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      if (!isForest(gx, gy)) continue;
      const { x: sx, y: sy } = worldToScreen(gx * TILE, gy * TILE);
      const ts = TILE * wScale;
      const v1 = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 55);
      // Быстрый генератор для лесных стеблей
      let hh = (Math.imul(gx, 374761393) + Math.imul(gy, 668265263) + 5500) | 0;
      const rn = () => { hh = Math.imul(hh ^ (hh >>> 13), 1274126177) ^ (hh >>> 16); return (hh >>> 0) / 4294967296; };
      for (let i = 0; i < 7; i++) {
        const rx = rn(), rh = rn(), ra = rn();
        const bx = sx + rx * ts, by = sy + ts;
        const bh = ts * 0.22 * (0.4 + rh * 0.6);
        ctx.strokeStyle = `hsl(${102 + v1*20},38%,${18 + rh*10}%)`;
        ctx.lineWidth   = 1.0;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + (ra - 0.5) * bh, by - bh);
        ctx.stroke();
      }
    }
  }
  // Деревья
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      if (!isForest(gx, gy)) continue;
      const v = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 300);
      if (v > 0.35) drawTree(gx, gy);
    }
  }
}

function drawTree(gx, gy) {
  const { x: sx, y: sy } = worldToScreen(gx * TILE, gy * TILE);
  const ts = TILE * wScale;
  const cx = sx + ts/2, cy = sy + ts/2;
  const h1 = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 200);
  const h2 = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 201);
  const h3 = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 202);
  const h4 = h01(gx & 0x7FFFFFFF, gy & 0x7FFFFFFF, 203);

  const tHue  = 108 + h1 * 24;
  const trnkH = ts * (0.28 + h2 * 0.14);
  const canR  = ts * (0.38 + h3 * 0.20);
  const trnkW = ts * 0.10;
  const topY  = cy - ts * 0.05;
  const trnkX = cx + (h4 - 0.5) * ts * 0.10;

  // Тень
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx + ts*0.06, topY + 5, canR*0.78, canR*0.44, 0, 0, Math.PI*2);
  ctx.fill();

  // Ствол
  ctx.fillStyle = `hsl(28,44%,${17 + h2*9}%)`;
  ctx.beginPath();
  ctx.roundRect(trnkX - trnkW/2, topY, trnkW, trnkH, trnkW*0.3);
  ctx.fill();

  // Крона (3 слоя)
  ctx.fillStyle = `hsl(${tHue},50%,${13 + h3*8}%)`;
  ctx.beginPath(); ctx.ellipse(cx, topY, canR, canR*0.88, 0, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = `hsl(${tHue+7},56%,${22 + h1*10}%)`;
  ctx.beginPath(); ctx.ellipse(cx - canR*0.20, topY - canR*0.12, canR*0.72, canR*0.68, -0.25, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = `hsl(${tHue+13},62%,${31 + h4*12}%)`;
  ctx.beginPath(); ctx.ellipse(cx - canR*0.30, topY - canR*0.24, canR*0.46, canR*0.44, -0.45, 0, Math.PI*2); ctx.fill();

  // Блик
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath(); ctx.ellipse(cx - canR*0.33, topY - canR*0.30, canR*0.28, canR*0.24, -0.6, 0, Math.PI*2); ctx.fill();
}

// ════════════════════════════════════════════════════════════
// ОТРИСОВКА — СЛЕДЫ ШИН (5 секунд, плавное исчезание)
// ════════════════════════════════════════════════════════════
function drawTireTracks(now) {
  while (tracks.length > 0 && now - tracks[0].t > TRACK_LIFE) tracks.shift();
  if (tracks.length < 2) return;

  const tw     = PLAYER_R * wScale * 0.13;
  const offset = PLAYER_R * wScale * 0.52;

  for (let i = 1; i < tracks.length; i++) {
    const a = tracks[i-1], b = tracks[i];
    if (Math.abs(b.t - a.t) > 250) continue; // разрыв при резком повороте
    const age   = (now - b.t) / TRACK_LIFE;
    const alpha = Math.max(0, (1 - age) * 0.55);
    if (alpha <= 0) continue;

    const { x: ax, y: ay } = worldToScreen(a.x, a.y);
    const { x: bx, y: by } = worldToScreen(b.x, b.y);

    ctx.lineWidth = tw; ctx.lineCap = 'butt';
    // Левый и правый след
    for (const side of [-1, 1]) {
      const ox = Math.cos(b.angle + Math.PI/2) * offset * side;
      const oy = Math.sin(b.angle + Math.PI/2) * offset * side;
      ctx.strokeStyle = `rgba(14,7,0,${alpha})`;
      ctx.beginPath(); ctx.moveTo(ax+ox, ay+oy); ctx.lineTo(bx+ox, by+oy); ctx.stroke();
      // Внутренний блик
      ctx.strokeStyle = `rgba(70,40,5,${alpha * 0.30})`;
      ctx.lineWidth = tw * 0.36;
      ctx.beginPath(); ctx.moveTo(ax+ox, ay+oy); ctx.lineTo(bx+ox, by+oy); ctx.stroke();
    }
  }
}

// ════════════════════════════════════════════════════════════
// ОТРИСОВКА — МАШИНА (вибрация подвески как на бездорожье)
// ════════════════════════════════════════════════════════════
function drawPlayer() {
  const { x: sx, y: sy } = worldToScreen(player.x, player.y);
  const r = PLAYER_R * wScale;
  const speed  = Math.sqrt(player.vx**2 + player.vy**2);
  const moving = speed > 10;

  // Покачивание подвески + джиттер кочек
  const bob  = moving ? Math.sin(player.bobPhase) * r * 0.08 : 0;
  const roll = moving ? Math.sin(player.bobPhase * 0.5) * 0.022 : 0;

  ctx.save();
  ctx.translate(sx + player.jx * r, sy + bob + player.jy * r);
  ctx.rotate(player.angle + roll);

  const bW = r * 0.88, bH = r * 1.50;

  // Тень
  ctx.save();
  ctx.translate(r * 0.13, r * 0.23);
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath(); ctx.ellipse(0, 0, r*0.88, r*0.52, 0, 0, Math.PI*2); ctx.fill();
  ctx.restore();

  // Колёса
  const wA = player.wheelAngle;
  const wheelPos = [
    [-bW*0.80, -bH*0.50], [bW*0.80, -bH*0.50],
    [-bW*0.80,  bH*0.33], [bW*0.80,  bH*0.33],
  ];
  for (const [wx, wy] of wheelPos) {
    ctx.save(); ctx.translate(wx, wy);
    // Покрышка
    ctx.fillStyle = '#161616';
    ctx.beginPath(); ctx.ellipse(0, 0, r*0.25, r*0.17, Math.PI/2, 0, Math.PI*2); ctx.fill();
    // Протектор
    ctx.strokeStyle = 'rgba(55,55,55,0.8)'; ctx.lineWidth = 0.8;
    for (let s = 0; s < 6; s++) {
      const ang = (s/6)*Math.PI*2 + wA;
      ctx.beginPath(); ctx.arc(0, 0, r*0.22, ang, ang + 0.34); ctx.stroke();
    }
    // Диск
    ctx.save(); ctx.rotate(wA);
    ctx.fillStyle = '#b5b5b5';
    ctx.beginPath(); ctx.ellipse(0, 0, r*0.135, r*0.092, Math.PI/2, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#7a7a7a'; ctx.lineWidth = 0.9;
    for (let s = 0; s < 5; s++) {
      const a = (s/5)*Math.PI*2;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*r*0.11, Math.sin(a)*r*0.075); ctx.stroke();
    }
    ctx.fillStyle = '#606060'; ctx.beginPath(); ctx.arc(0,0,r*0.038,0,Math.PI*2); ctx.fill();
    ctx.restore(); ctx.restore();
  }

  // Кузов
  ctx.fillStyle = '#c0392b';
  ctx.beginPath(); ctx.roundRect(-bW, -bH*0.60, bW*2, bH*1.36, r*0.26); ctx.fill();
  // Боковая полоса
  ctx.fillStyle = '#a93226';
  ctx.beginPath(); ctx.rect(-bW, -bH*0.08, bW*2, bH*0.14); ctx.fill();
  // Блик кузова
  const g = ctx.createLinearGradient(-bW, -bH*0.6, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(-bW, -bH*0.60, bW*2, bH*1.36, r*0.26); ctx.fill();

  // Кабина / стекло
  ctx.fillStyle = 'rgba(75,150,235,0.74)';
  ctx.beginPath(); ctx.roundRect(-bW*0.63, -bH*0.57, bW*1.26, bH*0.53, r*0.18); ctx.fill();
  // Центральная стойка
  ctx.strokeStyle = '#8a2020'; ctx.lineWidth = bW*0.09;
  ctx.beginPath(); ctx.moveTo(0, -bH*0.57); ctx.lineTo(0, -bH*0.04); ctx.stroke();
  // Блик стекла
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath(); ctx.roundRect(-bW*0.42, -bH*0.53, bW*0.44, bH*0.19, r*0.08); ctx.fill();

  // Фары
  const hlOn = speed > 5;
  ctx.shadowColor = hlOn ? '#ffe566' : 'transparent'; ctx.shadowBlur = hlOn ? 14 : 0;
  ctx.fillStyle   = hlOn ? '#ffe566' : '#998833';
  for (const hx of [-bW*0.52, bW*0.52]) {
    ctx.beginPath(); ctx.ellipse(hx, -bH*0.63, r*0.135, r*0.082, 0, 0, Math.PI*2); ctx.fill();
  }
  // Стопы
  ctx.shadowBlur = 0; ctx.fillStyle = speed > 5 ? '#ff4040' : '#7a1818';
  for (const hx of [-bW*0.53, bW*0.53]) {
    ctx.beginPath(); ctx.ellipse(hx, bH*0.73, r*0.10, r*0.072, 0, 0, Math.PI*2); ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ════════════════════════════════════════════════════════════
// ЛОГИКА
// ════════════════════════════════════════════════════════════
function getInput() {
  let dx = 0, dy = 0;
  if (keys['ArrowUp']   ||keys['w']||keys['W']||keys['ц']||keys['Ц']) dy -= 1;
  if (keys['ArrowDown'] ||keys['s']||keys['S']||keys['ы']||keys['Ы']) dy += 1;
  if (keys['ArrowLeft'] ||keys['a']||keys['A']||keys['ф']||keys['Ф']) dx -= 1;
  if (keys['ArrowRight']||keys['d']||keys['D']||keys['в']||keys['В']) dx += 1;
  if (joystick.active) { dx += joystick.dx; dy += joystick.dy; }
  if (mouseActive && mouseTarget) {
    const tdx = mouseTarget.x - player.x, tdy = mouseTarget.y - player.y;
    const dist = Math.sqrt(tdx*tdx + tdy*tdy);
    if (dist > TILE * 0.4) { dx = tdx/dist; dy = tdy/dist; }
  }
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len > 1) { dx /= len; dy /= len; }
  return { dx, dy };
}

function update(dt, now) {
  const { dx, dy } = getInput();
  player.vx = dx * SPEED;
  player.vy = dy * SPEED;

  // Движение (в пределах карты — не заходим в лес)
  player.x = clamp(player.x + player.vx * dt, PLAYER_R + 2, WORLD_W - PLAYER_R - 2);
  player.y = clamp(player.y + player.vy * dt, PLAYER_R + 2, WORLD_H - PLAYER_R - 2);

  // Поворот
  if (dx !== 0 || dy !== 0) player.targetAngle = Math.atan2(dy, dx) + Math.PI/2;
  let da = player.targetAngle - player.angle;
  while (da >  Math.PI) da -= Math.PI*2;
  while (da < -Math.PI) da += Math.PI*2;
  player.angle += da * 0.16;

  const speed = Math.sqrt(player.vx**2 + player.vy**2);

  // Колёса + подвеска
  player.wheelAngle += (speed * dt) / (PLAYER_R * 0.18);
  player.bobPhase   += speed * dt * 0.030;

  // Вибрация кочек — меняется каждые ~70мс
  player.jTimer -= dt * 1000;
  if (player.jTimer <= 0) {
    player.jTimer = 55 + Math.random() * 40;
    if (speed > 10) {
      const amp = Math.min(speed / SPEED, 1) * 0.072;
      player.jx = (Math.random() - 0.5) * amp;
      player.jy = (Math.random() - 0.5) * amp * 0.5;
    } else {
      player.jx = 0; player.jy = 0;
    }
  }

  // Камера
  camera.x = lerp(camera.x, player.x, CAM_LERP);
  camera.y = lerp(camera.y, player.y, CAM_LERP);

  // Спидометр
  speedFillEl.style.height = clamp(speed / SPEED * 100, 0, 100) + '%';

  // Следы шин
  if (speed > 8 && now - lastTrackTime > TRACK_MS) {
    tracks.push({ x: player.x, y: player.y, angle: player.angle, t: now });
    lastTrackTime = now;
  }

  // Сборка травы
  checkHarvest(now);

  // Рост травы — Minecraft стадии (мгновенно каждые STAGE_MS мс)
  for (const tile of tiles.values()) {
    if (tile.cutAt === null) continue;
    const elapsed  = now - tile.cutAt;
    const newStage = Math.min(STAGES, Math.floor(elapsed / STAGE_MS));
    if (newStage !== tile.stage) {
      tile.stage = newStage;
      if (tile.stage >= STAGES) { tile.cutAt = null; tile.stage = STAGES; }
    }
  }
}

function checkHarvest(now) {
  const gx0 = Math.floor(player.x / TILE);
  const gy0 = Math.floor(player.y / TILE);
  for (let ix = gx0 - 2; ix <= gx0 + 2; ix++) {
    for (let iy = gy0 - 2; iy <= gy0 + 2; iy++) {
      if (isForest(ix, iy)) continue;
      const tile = getTile(ix, iy);
      if (tile.cutAt !== null || tile.stage < STAGES) continue;
      const cx = (ix + 0.5) * TILE, cy = (iy + 0.5) * TILE;
      if (Math.sqrt((player.x-cx)**2 + (player.y-cy)**2) < PLAYER_R * 0.75 + TILE * 0.5) {
        tile.cutAt = now; tile.stage = 0;
        const { x: sx, y: sy } = worldToScreen(cx, cy);
        addCoin(sx, sy);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// ГЛАВНЫЙ ЦИКЛ
// ════════════════════════════════════════════════════════════
let lastTime = 0;

function gameLoop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  ctx.clearRect(0, 0, canvasW, canvasH);

  const mg = 3;
  const { x: wl, y: wt } = screenToWorld(0, 0);
  const { x: wr, y: wb } = screenToWorld(canvasW, canvasH);
  const gxMin = Math.floor(wl / TILE) - mg;
  const gxMax = Math.ceil (wr / TILE) + mg;
  const gyMin = Math.floor(wt / TILE) - mg;
  const gyMax = Math.ceil (wb / TILE) + mg;

  drawGround    (gxMin, gxMax, gyMin, gyMax);  // 1. Земля
  drawTireTracks(now);                          // 2. Следы шин (под травой)
  drawGrass     (gxMin, gxMax, gyMin, gyMax);  // 3. Трава
  drawForest    (gxMin, gxMax, gyMin, gyMax);  // 4. Лес

  update(dt, now);  // 5. Логика

  drawPlayer();     // 6. Машина

  requestAnimationFrame(gameLoop);
}

// ════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ════════════════════════════════════════════════════════════
function init() {
  resize();
  detectTouch();
  player.x = WORLD_W / 2; player.y = WORLD_H / 2;
  camera.x = player.x;    camera.y = player.y;
  window.addEventListener('resize', resize);
  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

init();

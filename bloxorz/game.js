/**
 * Bloxorz 3D — multi-block, timed, no-fall tip/slide (Lego / Block Out look).
 * Top-down camera; per-block swipe; N blocks ↔ N holes; upright-in-hole only.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const DIRS = {
  up: { dx: 0, dy: -1, name: "up" },
  down: { dx: 0, dy: 1, name: "down" },
  left: { dx: -1, dy: 0, name: "left" },
  right: { dx: 1, dy: 0, name: "right" },
};

const TILE_H = 0.22;
/** Roll timings by move type — tipping over is heavier than standing up. */
const ROLL_MS_TIP = 205; // upright -> flat (falls over)
const ROLL_MS_RISE = 245; // flat -> upright (has to lift its mass)
const ROLL_MS_SIDE = 170; // flat -> flat (light side roll)
// --- Sink (fall into the hole) ---
// The brick tips over the lip, then free-falls: drop grows with t^2, i.e.
// constant gravity. The fall is only "done" once the board has swallowed it
// whole, plus a tail where it keeps dropping out of sight — nothing ever pops.
const SINK_TIP_MS = 120; // loses its footing at the mouth
const SINK_FALL_MS = 620; // free fall, ends the frame the brick is fully under
const SINK_TAIL_MS = 170; // still falling, now out of sight
const SINK_MS = SINK_TIP_MS + SINK_FALL_MS + SINK_TAIL_MS;
const SINK_TIP_DROP = 0.16; // dip before gravity takes over (world units)
const SINK_TILT = 0.13; // radians of topple on the way down
/** Board surface — a sinking brick's clip plane rises to here so the floor eats it. */
const SINK_CLIP_Y = TILE_H + 0.01;
/** Clip-plane constant that parks a brick's plane far below the world (clips nothing). */
const CLIP_PARKED = 1000;
const NUDGE_MS = 190; // rejected-move bump
const OUTLINE_PAD = 0.075; // white shell thickness around the selected brick (world units)
const DEFAULT_TIME = 120;

const BLOCK_COLORS = [
  { block: 0xe31c23, dark: 0xb01419, edge: 0xff6b6b, stud: 0xc9181e },
  { block: 0x2ecc71, dark: 0x1e8449, edge: 0x7dffa8, stud: 0x27ae60 },
  { block: 0xe67e22, dark: 0xa85a12, edge: 0xffb070, stud: 0xd35400 },
  { block: 0x9b59b6, dark: 0x6c3483, edge: 0xd7a0f0, stud: 0x8e44ad },
];

const PALETTE = {
  bg: 0x1c2238,
  fog: 0x1c2238,
  tileTop: 0xf5c518,
  tileSide: 0xd4a80f,
  tileUnder: 0x8a6d08,
  tileCrease: 0xc49a0c,
  holeRim: 0x1e90ff,
  holeRimDark: 0x1560b0,
  holeVoid: 0x010208,
  holeGlow: 0x2a8cff,
  ground: 0x4a5570,
  stud: 0xe8b410,
  select: 0xffffff,
};

/** Tint used for rejected-move feedback on the outline / footprint ring. */
const REJECT_COLOR = new THREE.Color(0xff3b3b);

let showStuds = false;

// --- DOM ---
const canvas = document.getElementById("game");
const stage = document.getElementById("stage");
const elLevel = document.getElementById("level-label");
const elMoves = document.getElementById("moves-label");
const elTimer = document.getElementById("timer-label");
const elBlocks = document.getElementById("blocks-label");
const elStatus = document.getElementById("status");
const howto = document.getElementById("howto");
const btnHowtoClose = document.getElementById("howto-close");
const btnRestart = document.getElementById("btn-restart");
const btnHowto = document.getElementById("btn-howto");
const btnStuds = document.getElementById("btn-studs");
const btnOverflow = document.getElementById("btn-overflow");
const overflowMenu = document.getElementById("overflow-menu");
const elResult = document.getElementById("result");
const elResultTitle = document.getElementById("result-title");
const elResultSub = document.getElementById("result-sub");
const btnResultCta = document.getElementById("result-cta");
const elFxFlash = document.getElementById("fx-flash");
const elApp = document.getElementById("app");
const resultCard = elResult ? elResult.querySelector(".result-card") : null;

/** Pending result action: "next" | "retry" | "done" */
let pendingResultAction = null;

// --- State ---
let levels = window.BLOXORZ_LEVELS || [];
let levelIndex = 0;
let tiles = [];
let cols = 0;
let rows = 0;
let holePositions = [];
/** @type {{ id:number, x:number, y:number, orient:string, sunk:boolean, mesh:THREE.Group|null, studGroup:THREE.Group|null, highlight:THREE.Mesh|null }[]} */
let blocks = [];
let selectedId = 0;
let moves = 0;
let animating = false;
let won = false;
let failed = false;
let timeLimit = DEFAULT_TIME;
let timeLeft = DEFAULT_TIME;
let timerRunning = false;
let lastTick = 0;

// --- Three.js ---
let renderer, scene, camera, clock;
let boardGroup = null;
let pivot = null;
let anim = null;
let softLight, dirLight;
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function plasticMat(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: opts.roughness ?? 0.38,
    metalness: opts.metalness ?? 0.02,
    clearcoat: opts.clearcoat ?? 0.65,
    clearcoatRoughness: opts.clearcoatRoughness ?? 0.28,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
}

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true; // per-brick clip plane, used by sinkBlock
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.Fog(PALETTE.fog, 16, 40);

  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

  softLight = new THREE.AmbientLight(0xfff4e0, 0.42);
  scene.add(softLight);

  const hemi = new THREE.HemisphereLight(0xffe8b0, 0x1a2040, 0.55);
  scene.add(hemi);

  dirLight = new THREE.DirectionalLight(0xfff8f0, 1.25);
  dirLight.position.set(5, 12, 6);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 40;
  dirLight.shadow.camera.left = -14;
  dirLight.shadow.camera.right = 14;
  dirLight.shadow.camera.top = 14;
  dirLight.shadow.camera.bottom = -14;
  dirLight.shadow.bias = -0.0006;
  dirLight.shadow.normalBias = 0.03;
  scene.add(dirLight);

  const fill = new THREE.DirectionalLight(0x6ea8ff, 0.28);
  fill.position.set(-7, 5, -5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffc8a0, 0.18);
  rim.position.set(2, 3, -8);
  scene.add(rim);

  clock = new THREE.Clock();
  resize();
  requestAnimationFrame(loop);
}

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (w < 1 || h < 1) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fitCamera();
}

function fitCamera() {
  if (!cols || !rows) return;
  const cx = (cols - 1) / 2;
  const cz = (rows - 1) / 2;
  const span = Math.max(cols, rows);
  // Straight top-down (no isometric) — swipe maps 1:1 to grid
  const height = span * 1.35 + 5.5;
  camera.position.set(cx, height, cz + 0.01);
  camera.lookAt(cx, 0, cz);
  camera.fov = 40;
  camera.updateProjectionMatrix();
  dirLight.position.set(cx + 4, height * 0.9, cz + 5);
  dirLight.target.position.set(cx, 0, cz);
  scene.add(dirLight.target);
}

// --- Level parse / load ---
const START_LETTERS = "SABCDEFGHIJKLMNOPQR";

function parseLevel(level) {
  const grid = level.grid;
  rows = grid.length;
  cols = Math.max(...grid.map((r) => r.length));
  tiles = [];
  holePositions = [];
  const letterStarts = {};

  for (let y = 0; y < rows; y++) {
    const row = [];
    const line = grid[y].padEnd(cols, "0");
    for (let x = 0; x < cols; x++) {
      const ch = line[x];
      if (START_LETTERS.includes(ch)) {
        row.push(1);
        letterStarts[ch] = { x, y };
      } else if (ch === "2") {
        row.push(2);
        holePositions.push({ x, y });
      } else if (ch === "1") {
        row.push(1);
      } else {
        row.push(0);
      }
    }
    tiles.push(row);
  }

  let starts = [];
  if (Array.isArray(level.starts) && level.starts.length) {
    starts = level.starts.map((p) => ({ x: p.x, y: p.y }));
  } else {
    // Stable order S,A,B,C… — each letter at most once (Object keys are unique)
    const order = "SABCDEFGHIJKLMNOPQR";
    const seenPos = new Set();
    for (const ch of order) {
      const pos = letterStarts[ch];
      if (!pos) continue;
      const key = `${pos.x},${pos.y}`;
      if (seenPos.has(key)) continue;
      seenPos.add(key);
      starts.push(pos);
    }
  }
  return starts;
}

function disposeObject(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    // Footprint outlines share cached geometry across blocks/levels — never dispose those.
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}

function clearBlocks() {
  for (const b of blocks) {
    if (b.mesh) {
      scene.remove(b.mesh);
      disposeObject(b.mesh);
    }
    if (b.highlight) {
      scene.remove(b.highlight);
      disposeObject(b.highlight);
    }
  }
  blocks = [];
}

function loadLevel(index) {
  levelIndex = Math.max(0, Math.min(index, levels.length - 1));
  const level = levels[levelIndex];
  const starts = parseLevel(level);

  clearPivot();
  clearFx();
  clearBlocks();
  anim = null;
  animating = false;
  won = false;
  failed = false;
  moves = 0;
  selectedId = 0;
  hideResult();

  timeLimit = level.timeLimit ?? DEFAULT_TIME;
  timeLeft = timeLimit;
  timerRunning = true;
  lastTick = performance.now();

  buildBoard();

  // Dedupe start cells — never spawn two blocks on the same tile
  const seen = new Set();
  const uniqueStarts = [];
  for (const pos of starts) {
    const key = `${pos.x},${pos.y}`;
    if (seen.has(key)) {
      console.error("[bloxorz] duplicate start ignored", pos);
      continue;
    }
    seen.add(key);
    uniqueStarts.push(pos);
  }

  uniqueStarts.forEach((pos, i) => {
    const b = {
      id: i,
      x: pos.x,
      y: pos.y,
      orient: "upright",
      sunk: false,
      mesh: null,
      studGroup: null,
      highlight: null,
      colors: null,
      clipPlane: null,
      _reserve: null,
      _sinkFx: null,
      _nudgeFx: null,
      _punchFx: null,
      _rejectFx: null,
    };
    createBlockMesh(b, i);
    placeBlock(b);
    blocks.push(b);
  });

  if (!assertNoOverlaps("spawn")) {
    console.error("[bloxorz] spawn overlap in level", level.id, level.name);
  }

  updateSelectionVisuals();
  updateHUD();
  setStatus("");
  fitCamera();
}

function formatTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function sunkCount() {
  return blocks.filter((b) => b.sunk).length;
}

function updateHUD() {
  const lv = levels[levelIndex];
  if (elLevel) {
    const name = lv.name ? ` · ${lv.name}` : "";
    elLevel.textContent = `Lv ${lv.id}${name}`;
    elLevel.title = `Level ${lv.id}${lv.name ? " — " + lv.name : ""}`;
  }
  if (elMoves) {
    elMoves.textContent = String(moves);
    elMoves.title = `Moves: ${moves}`;
  }
  if (elTimer) {
    elTimer.textContent = formatTime(timeLeft);
    elTimer.classList.toggle("urgent", timeLeft <= 15 && !won && !failed);
    elTimer.title = `Time left: ${formatTime(timeLeft)}`;
  }
  if (elBlocks) {
    const left = blocks.length - sunkCount();
    elBlocks.textContent = `${left}/${blocks.length}`;
    elBlocks.title = `Blocks remaining: ${left} of ${blocks.length}`;
    // Only show Blocks chip when multi-block
    elBlocks.hidden = blocks.length <= 1;
  }
}

let statusToken = 0;

function setStatus(msg, kind, autoClearMs) {
  if (!elStatus) return;
  const token = ++statusToken;
  elStatus.textContent = msg || "";
  elStatus.className = "status sr-status";
  // reflow so a repeat of the same status re-runs its pop animation
  void elStatus.offsetWidth;
  elStatus.className = "status sr-status" + (kind ? " " + kind : "");
  if (autoClearMs) {
    window.setTimeout(() => {
      if (token === statusToken) setStatus("");
    }, autoClearMs);
  }
}

// --- FX runner (time-based, independent of gameplay animation) ---
/** @type {{t0:number,dur:number,update:(p:number)=>void,end:(cancelled:boolean)=>void}[]} */
const fxList = [];

function addFx(dur, update, end) {
  const item = { t0: performance.now(), dur: Math.max(1, dur), update, end };
  fxList.push(item);
  return item;
}

function updateFx(now) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    const p = Math.min(1, (now - f.t0) / f.dur);
    f.update(p);
    if (p >= 1) {
      fxList.splice(i, 1);
      if (f.end) f.end(false);
    }
  }
}

/** Stop one running FX early (its end handler still runs, flagged as cancelled). */
function cancelFx(item) {
  const i = fxList.indexOf(item);
  if (i === -1) return;
  fxList.splice(i, 1);
  if (item.end) item.end(true);
}

function clearFx() {
  while (fxList.length) {
    const f = fxList.pop();
    if (f.end) f.end(true);
  }
}

function haptic(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (_) {}
}

/**
 * Short-lived particle puff. One THREE.Points per burst, disposed when done —
 * counts stay small so this is cheap on phones.
 */
function spawnBurst(x, y, z, color, count, opts = {}) {
  const life = opts.life ?? 620;
  const spread = opts.spread ?? 1.5;
  const up = opts.up ?? 2.2;
  const gravity = opts.gravity ?? 5.4;
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = spread * (0.35 + Math.random() * 0.65);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vel[i * 3] = Math.cos(a) * r;
    vel[i * 3 + 1] = up * (0.45 + Math.random() * 0.85);
    vel[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color,
    size: opts.size ?? 0.17,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);

  const arr = geo.attributes.position.array;
  addFx(
    life,
    (p) => {
      const t = p * (life / 1000);
      for (let i = 0; i < count; i++) {
        arr[i * 3] = x + vel[i * 3] * t;
        arr[i * 3 + 1] = y + vel[i * 3 + 1] * t - 0.5 * gravity * t * t;
        arr[i * 3 + 2] = z + vel[i * 3 + 2] * t;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 1 - p * p;
    },
    () => {
      scene.remove(pts);
      disposeObject(pts);
    }
  );
}

/** Expanding shockwave ring on the board plane. */
function spawnShockwave(x, z, color, opts = {}) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: opts.opacity ?? 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.46, 32), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, TILE_H + 0.07, z);
  scene.add(ring);
  const to = opts.to ?? 2.8;
  const from = opts.from ?? 0.55;
  const base = mat.opacity;
  addFx(
    opts.life ?? 560,
    (p) => {
      // ring is rotated -90deg about X, so local X/Y are the world ground plane
      const s = from + (to - from) * (1 - Math.pow(1 - p, 2));
      ring.scale.set(s, s, 1);
      mat.opacity = base * (1 - p) * (1 - p);
    },
    () => {
      scene.remove(ring);
      disposeObject(ring);
    }
  );
}

// --- Juice (CSS class hooks; no physics changes) ---
const FLASH_KINDS = ["sink", "fail", "win", "reject"];
let flashToken = 0;

function flashScreen(kind = "sink") {
  if (!elFxFlash) return;
  const token = ++flashToken;
  elFxFlash.classList.remove("on", ...FLASH_KINDS);
  // reflow so animation restarts
  void elFxFlash.offsetWidth;
  elFxFlash.classList.add("on", kind);
  window.setTimeout(() => {
    // a newer flash may have started; only the latest one clears
    if (token === flashToken) elFxFlash.classList.remove("on", ...FLASH_KINDS);
  }, 420);
}

let shakeToken = 0;

/** kind: "hard" (fail) | "soft" (blocked move / sink thud) */
function shakeStage(kind = "hard") {
  if (!stage) return;
  const cls = kind === "soft" ? "fx-shake-soft" : "fx-shake";
  const token = ++shakeToken;
  stage.classList.remove("fx-shake", "fx-shake-soft");
  void stage.offsetWidth;
  stage.classList.add(cls);
  window.setTimeout(
    () => {
      if (token === shakeToken) stage.classList.remove("fx-shake", "fx-shake-soft");
    },
    kind === "soft" ? 300 : 460
  );
}

function celebratePulse() {
  if (!elApp) return;
  elApp.classList.remove("fx-celebrate");
  void elApp.offsetWidth;
  elApp.classList.add("fx-celebrate");
  window.setTimeout(() => elApp.classList.remove("fx-celebrate"), 750);
}

function hideResult() {
  if (!elResult) return;
  elResult.classList.add("hidden");
  pendingResultAction = null;
  if (resultCard) resultCard.classList.remove("win", "fail");
}

function showResult({ title, sub, cta, kind, action }) {
  if (!elResult) return;
  pendingResultAction = action;
  if (elResultTitle) elResultTitle.textContent = title;
  if (elResultSub) elResultSub.textContent = sub || "";
  if (btnResultCta) btnResultCta.textContent = cta;
  if (resultCard) {
    resultCard.classList.remove("win", "fail");
    if (kind) resultCard.classList.add(kind);
  }
  elResult.classList.remove("hidden");
}

/** Damped squash-and-stretch when a brick lands. Runs on the FX clock, not a timeout. */
function impactPunch(block, strength = 1) {
  if (!block || !block.mesh || block.sunk) return;
  const mesh = block.mesh;
  if (block._punchFx) cancelFx(block._punchFx);
  const amp = 0.085 * strength;
  block._punchFx = addFx(
    190,
    (p) => {
      if (block.sunk || !mesh.visible) return;
      const k = (1 - p) * (1 - p) * Math.cos(p * 9);
      mesh.scale.set(1 + amp * k, 1 - amp * k, 1 + amp * k);
    },
    () => {
      block._punchFx = null;
      if (!block.sunk) mesh.scale.set(1, 1, 1);
    }
  );
}

/** Rounded-rect path used for both the footprint outline and its glow fill. */
function roundedRectShape(w, h, r) {
  const hw = w / 2;
  const hh = h / 2;
  const rad = Math.min(r, hw, hh);
  const sh = new THREE.Shape();
  sh.moveTo(-hw + rad, -hh);
  sh.lineTo(hw - rad, -hh);
  sh.absarc(hw - rad, -hh + rad, rad, -Math.PI / 2, 0, false);
  sh.lineTo(hw, hh - rad);
  sh.absarc(hw - rad, hh - rad, rad, 0, Math.PI / 2, false);
  sh.lineTo(-hw + rad, hh);
  sh.absarc(-hw + rad, hh - rad, rad, Math.PI / 2, Math.PI, false);
  sh.lineTo(-hw, -hh + rad);
  sh.absarc(-hw + rad, -hh + rad, rad, Math.PI, 1.5 * Math.PI, false);
  return sh;
}

// Three footprint shapes only (1x1, 2x1, 1x2) — built once, shared by every block.
const footprintGeoCache = new Map();

function footprintGeo(w, h, stroked) {
  const key = `${w}x${h}${stroked ? "s" : "f"}`;
  const hit = footprintGeoCache.get(key);
  if (hit) return hit;
  const ow = w - 0.08;
  const oh = h - 0.08;
  const shape = roundedRectShape(ow, oh, 0.18);
  if (stroked) {
    const t = 0.115;
    const inner = roundedRectShape(ow - t * 2, oh - t * 2, 0.1);
    shape.holes.push(new THREE.Path(inner.getPoints(10)));
  }
  const geo = new THREE.ShapeGeometry(shape, 8);
  geo.userData.shared = true;
  footprintGeoCache.set(key, geo);
  return geo;
}

const footprintOutlineGeo = (w, h) => footprintGeo(w, h, true);
const footprintFillGeo = (w, h) => footprintGeo(w, h, false);

function closeOverflow() {
  if (overflowMenu) overflowMenu.classList.add("hidden");
  if (btnOverflow) btnOverflow.setAttribute("aria-expanded", "false");
}

function makeStudCluster(mat, yTop) {
  const g = new THREE.Group();
  g.name = "studs";
  const geo = new THREE.CylinderGeometry(0.11, 0.12, 0.07, 18);
  const offsets = [
    [-0.25, 0.25],
    [0.25, 0.25],
    [-0.25, -0.25],
    [0.25, -0.25],
  ];
  for (const [ox, oz] of offsets) {
    const stud = new THREE.Mesh(geo, mat);
    stud.position.set(ox, yTop + 0.035, oz);
    stud.castShadow = true;
    stud.receiveShadow = true;
    g.add(stud);
  }
  return g;
}

// --- Board ---
function buildBoard() {
  if (boardGroup) {
    scene.remove(boardGroup);
    disposeObject(boardGroup);
  }
  boardGroup = new THREE.Group();
  scene.add(boardGroup);

  const tileTopMat = plasticMat(PALETTE.tileTop, { roughness: 0.36, clearcoat: 0.7 });
  const tileRimMat = plasticMat(PALETTE.tileCrease, { roughness: 0.5, clearcoat: 0.4 });
  const holeRimMat = plasticMat(PALETTE.holeRim, {
    roughness: 0.28,
    clearcoat: 0.85,
    emissive: PALETTE.holeGlow,
    emissiveIntensity: 0.45,
  });
  const holeVoidMat = new THREE.MeshStandardMaterial({
    color: PALETTE.holeVoid,
    roughness: 1,
    metalness: 0,
  });
  const studMat = plasticMat(PALETTE.stud, { roughness: 0.34, clearcoat: 0.8 });

  const bevel = 0.1;
  const segs = 4;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = tiles[y][x];
      if (t === 0) continue;

      if (t === 2) {
        const base = new THREE.Mesh(
          new RoundedBoxGeometry(0.96, TILE_H, 0.96, segs, bevel * 0.7),
          holeRimMat
        );
        base.position.set(x, TILE_H / 2, y);
        base.castShadow = true;
        base.receiveShadow = true;
        boardGroup.add(base);

        const voidMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.62, TILE_H * 1.2, 0.62),
          holeVoidMat
        );
        voidMesh.position.set(x, TILE_H * 0.35, y);
        boardGroup.add(voidMesh);

        const lip = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.72), holeRimMat);
        lip.position.set(x, TILE_H + 0.008, y);
        lip.receiveShadow = true;
        boardGroup.add(lip);

        const well = new THREE.Mesh(
          new THREE.CylinderGeometry(0.34, 0.38, 0.1, 24),
          holeVoidMat
        );
        well.position.set(x, TILE_H - 0.02, y);
        boardGroup.add(well);

        const targetRing = new THREE.Mesh(
          new THREE.RingGeometry(0.3, 0.4, 28),
          new THREE.MeshStandardMaterial({
            color: 0x66b8ff,
            emissive: 0x3a9eff,
            emissiveIntensity: 0.55,
            roughness: 0.4,
            metalness: 0,
            side: THREE.DoubleSide,
          })
        );
        targetRing.rotation.x = -Math.PI / 2;
        targetRing.position.set(x, TILE_H + 0.02, y);
        boardGroup.add(targetRing);
      } else {
        const geo = new RoundedBoxGeometry(0.94, TILE_H, 0.94, segs, bevel);
        const mesh = new THREE.Mesh(geo, tileTopMat);
        mesh.position.set(x, TILE_H / 2, y);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        boardGroup.add(mesh);

        const cap = new THREE.Mesh(
          new RoundedBoxGeometry(0.78, 0.035, 0.78, 2, 0.04),
          tileTopMat
        );
        cap.position.set(x, TILE_H + 0.012, y);
        cap.receiveShadow = true;
        boardGroup.add(cap);

        const crease = new THREE.Mesh(
          new THREE.BoxGeometry(0.86, 0.012, 0.86),
          tileRimMat
        );
        crease.position.set(x, TILE_H - 0.002, y);
        crease.receiveShadow = true;
        boardGroup.add(crease);

        if (showStuds) {
          const studs = makeStudCluster(studMat, TILE_H + 0.028);
          studs.position.set(x, 0, y);
          boardGroup.add(studs);
        }
      }
    }
  }

  const padR = Math.max(cols, rows) * 0.9 + 3.8;
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(padR, 48),
    new THREE.MeshStandardMaterial({
      color: PALETTE.ground,
      roughness: 0.88,
      metalness: 0.05,
      emissive: 0x1a2238,
      emissiveIntensity: 0.15,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((cols - 1) / 2, -0.05, (rows - 1) / 2);
  ground.receiveShadow = true;
  boardGroup.add(ground);

  const groundRing = new THREE.Mesh(
    new THREE.RingGeometry(padR - 0.15, padR + 0.55, 48),
    new THREE.MeshStandardMaterial({
      color: 0x6a7898,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      emissive: 0x2a3550,
      emissiveIntensity: 0.12,
    })
  );
  groundRing.rotation.x = -Math.PI / 2;
  groundRing.position.set((cols - 1) / 2, -0.04, (rows - 1) / 2);
  boardGroup.add(groundRing);
}

// --- Block meshes ---
function createBlockMesh(b, colorIndex) {
  const colors = BLOCK_COLORS[colorIndex % BLOCK_COLORS.length];
  b.colors = colors;
  const group = new THREE.Group();
  group.name = `block-${b.id}`;
  group.userData.blockId = b.id;

  const bodyMat = plasticMat(colors.block, {
    roughness: 0.32,
    clearcoat: 0.8,
    clearcoatRoughness: 0.22,
    emissive: colors.dark,
    emissiveIntensity: 0.08,
  });
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.96, 1.96, 0.96, 4, 0.1), bodyMat);
  body.name = "body";
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.blockId = b.id;
  group.add(body);

  const seam = new THREE.Mesh(
    new THREE.BoxGeometry(0.98, 0.04, 0.98),
    plasticMat(colors.dark, { roughness: 0.55, clearcoat: 0.25 })
  );
  seam.name = "seam";
  group.add(seam);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 1.98, 0.98)),
    new THREE.LineBasicMaterial({
      color: colors.edge,
      transparent: true,
      opacity: 0.35,
    })
  );
  edges.name = "edges";
  group.add(edges);

  // Selected-brick marker: a solid white inverted hull. Back faces only, so the
  // body hides everything except a constant-width rim around the silhouette.
  // toneMapped:false keeps it pure white through ACES tone mapping (reads on phones).
  const outline = new THREE.Mesh(
    new RoundedBoxGeometry(
      0.96 + OUTLINE_PAD * 2,
      1.96 + OUTLINE_PAD * 2,
      0.96 + OUTLINE_PAD * 2,
      4,
      0.1 + OUTLINE_PAD
    ),
    new THREE.MeshBasicMaterial({
      color: PALETTE.select,
      side: THREE.BackSide,
      toneMapped: false,
      transparent: true,
      opacity: 1,
    })
  );
  outline.name = "outline";
  outline.visible = false;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.raycast = () => {}; // never steal a tap from the body
  group.add(outline);

  const studGroup = new THREE.Group();
  studGroup.name = "blockStuds";
  const studMat = plasticMat(colors.stud, { roughness: 0.3, clearcoat: 0.85 });
  studGroup.add(makeStudCluster(studMat, 0.98));
  studGroup.visible = showStuds;
  group.add(studGroup);

  // Every brick owns one clipping plane, parked far below the world so it clips
  // nothing. sinkBlock() raises it to board level, so the floor swallows the
  // brick as it drops instead of the brick sliding out from under the tile (the
  // camera is top-down but still perspective, so off-centre holes would show it).
  // Wired up here so the clipped shader variant compiles at level load, not mid-fall.
  b.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), CLIP_PARKED);
  const clipPlanes = [b.clipPlane];
  group.traverse((o) => {
    const m = o.material;
    if (!m || Array.isArray(m)) return;
    m.clippingPlanes = clipPlanes;
    m.clipShadows = true; // the cast shadow shrinks with the brick as it goes under
  });

  scene.add(group);
  b.mesh = group;
  b.studGroup = studGroup;

  // World-space selection ring + soft glow disc (stays flat under footprint)
  const hlGroup = new THREE.Group();
  hlGroup.name = "selectRing";
  hlGroup.userData.blockId = b.id;
  hlGroup.visible = false;

  const ring = new THREE.Mesh(
    footprintOutlineGeo(1, 1),
    new THREE.MeshBasicMaterial({
      color: PALETTE.select,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.name = "ring";
  hlGroup.add(ring);

  const glow = new THREE.Mesh(
    footprintFillGeo(1, 1),
    new THREE.MeshBasicMaterial({
      color: colors.edge,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.005;
  glow.name = "glow";
  hlGroup.add(glow);

  scene.add(hlGroup);
  b.highlight = hlGroup;
}

function poseTransform(b) {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  if (b.orient === "upright") {
    pos.set(b.x, 1 + TILE_H, b.y);
    quat.identity();
  } else if (b.orient === "flat-x") {
    pos.set(b.x + 0.5, 0.5 + TILE_H, b.y);
    quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  } else {
    pos.set(b.x, 0.5 + TILE_H, b.y + 0.5);
    quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  }
  return { position: pos, quaternion: quat };
}

function placeBlock(b) {
  if (!b.mesh) return;
  clearPivot();
  const t = poseTransform(b);
  b.mesh.position.copy(t.position);
  b.mesh.quaternion.copy(t.quaternion);
  b.mesh.visible = !b.sunk;
  b.mesh.scale.set(1, 1, 1);
  if (!b.mesh.parent || b.mesh.parent !== scene) {
    scene.attach(b.mesh);
  }
  updateHighlightPos(b);
}

function updateHighlightPos(b) {
  if (!b.highlight) return;
  const cells = footprint(b);
  let cx = 0;
  let cz = 0;
  for (const c of cells) {
    cx += c.x;
    cz += c.y;
  }
  cx /= cells.length;
  cz /= cells.length;
  // Swap in the outline that actually matches the footprint (1x1 / 2x1 / 1x2)
  const w = b.orient === "flat-x" ? 2 : 1;
  const h = b.orient === "flat-y" ? 2 : 1;
  const ring = b.highlight.getObjectByName("ring");
  const glow = b.highlight.getObjectByName("glow");
  if (ring) ring.geometry = footprintOutlineGeo(w, h);
  if (glow) glow.geometry = footprintFillGeo(w, h);
  b.highlight.scale.set(1, 1, 1);
  b.highlight.position.set(cx, TILE_H + 0.045, cz);
}

function setOutlineVisible(b, on) {
  if (!b.mesh) return;
  const o = b.mesh.getObjectByName("outline");
  if (o) o.visible = !!on;
}

function updateSelectionVisuals() {
  for (const b of blocks) {
    const isSel = !b.sunk && b.id === selectedId;
    setOutlineVisible(b, isSel);
    if (b.highlight) {
      b.highlight.visible = isSel;
      if (isSel) updateHighlightPos(b);
    }
  }
}

function clearPivot() {
  if (pivot) {
    for (const b of blocks) {
      if (b.mesh && b.mesh.parent === pivot) {
        scene.attach(b.mesh);
      }
    }
    scene.remove(pivot);
    pivot = null;
  }
}

function getRollPivot(from, dirName) {
  const { x, y, orient } = from;
  const y0 = TILE_H;
  if (orient === "upright") {
    if (dirName === "right")
      return { pivot: new THREE.Vector3(x + 0.5, y0, y), axis: new THREE.Vector3(0, 0, 1), angle: -Math.PI / 2 };
    if (dirName === "left")
      return { pivot: new THREE.Vector3(x - 0.5, y0, y), axis: new THREE.Vector3(0, 0, 1), angle: Math.PI / 2 };
    if (dirName === "down")
      return { pivot: new THREE.Vector3(x, y0, y + 0.5), axis: new THREE.Vector3(1, 0, 0), angle: Math.PI / 2 };
    if (dirName === "up")
      return { pivot: new THREE.Vector3(x, y0, y - 0.5), axis: new THREE.Vector3(1, 0, 0), angle: -Math.PI / 2 };
  }
  if (orient === "flat-x") {
    if (dirName === "right")
      return { pivot: new THREE.Vector3(x + 1.5, y0, y), axis: new THREE.Vector3(0, 0, 1), angle: -Math.PI / 2 };
    if (dirName === "left")
      return { pivot: new THREE.Vector3(x - 0.5, y0, y), axis: new THREE.Vector3(0, 0, 1), angle: Math.PI / 2 };
    if (dirName === "down")
      return { pivot: new THREE.Vector3(x + 0.5, y0, y + 0.5), axis: new THREE.Vector3(1, 0, 0), angle: Math.PI / 2 };
    if (dirName === "up")
      return { pivot: new THREE.Vector3(x + 0.5, y0, y - 0.5), axis: new THREE.Vector3(1, 0, 0), angle: -Math.PI / 2 };
  }
  if (orient === "flat-y") {
    if (dirName === "down")
      return { pivot: new THREE.Vector3(x, y0, y + 1.5), axis: new THREE.Vector3(1, 0, 0), angle: Math.PI / 2 };
    if (dirName === "up")
      return { pivot: new THREE.Vector3(x, y0, y - 0.5), axis: new THREE.Vector3(1, 0, 0), angle: -Math.PI / 2 };
    if (dirName === "right")
      return { pivot: new THREE.Vector3(x + 0.5, y0, y + 0.5), axis: new THREE.Vector3(0, 0, 1), angle: -Math.PI / 2 };
    if (dirName === "left")
      return { pivot: new THREE.Vector3(x - 0.5, y0, y + 0.5), axis: new THREE.Vector3(0, 0, 1), angle: Math.PI / 2 };
  }
  return null;
}

// --- Mechanics ---
function footprint(b) {
  if (b.orient === "upright") return [{ x: b.x, y: b.y }];
  if (b.orient === "flat-x")
    return [
      { x: b.x, y: b.y },
      { x: b.x + 1, y: b.y },
    ];
  return [
    { x: b.x, y: b.y },
    { x: b.x, y: b.y + 1 },
  ];
}

function tileAt(x, y) {
  if (y < 0 || y >= rows || x < 0 || x >= cols) return 0;
  return tiles[y][x];
}

function isSupported(b) {
  return footprint(b).every((c) => tileAt(c.x, c.y) !== 0);
}

function cellsOverlap(a, b) {
  const fa = footprint(a);
  const fb = footprint(b);
  return fa.some((ca) => fb.some((cb) => ca.x === cb.x && ca.y === cb.y));
}

/**
 * Cells occupied by every block except selfId.
 * Sunk blocks still own their hole cell — nothing may overlap them (no stacking).
 * While a block is rolling, both its from+to footprints are reserved.
 */
function occupiedCells(exceptId) {
  const cells = [];
  const pushFoot = (b) => {
    for (const c of footprint(b)) cells.push({ x: c.x, y: c.y, id: b.id });
  };
  for (const o of blocks) {
    if (o.id === exceptId) continue;
    pushFoot(o);
    if (o._reserve) {
      for (const c of o._reserve) cells.push({ x: c.x, y: c.y, id: o.id });
    }
  }
  return cells;
}

function poseOverlapsOccupied(proposed, exceptId) {
  const foot = footprint(proposed);
  const occ = occupiedCells(exceptId);
  return foot.some((ca) => occ.some((cb) => ca.x === cb.x && ca.y === cb.y));
}

function collidesWithOthers(proposed, selfId) {
  return poseOverlapsOccupied(proposed, selfId);
}

/** Hole already occupied by a sunk block (or any block standing there). */
function holeOccupied(x, y, exceptId) {
  return occupiedCells(exceptId).some((c) => c.x === x && c.y === y);
}

/** True if any two blocks share a footprint cell. */
function findOverlapPair() {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (cellsOverlap(blocks[i], blocks[j])) return [blocks[i], blocks[j]];
    }
  }
  return null;
}

function assertNoOverlaps(ctx) {
  const pair = findOverlapPair();
  if (!pair) return true;
  console.error("[bloxorz] overlap detected at", ctx, pair.map((b) => ({
    id: b.id, x: b.x, y: b.y, orient: b.orient, sunk: b.sunk,
  })));
  return false;
}

function isUprightInHole(b) {
  return b.orient === "upright" && tileAt(b.x, b.y) === 2;
}

function roll(b, dir) {
  const { dx, dy } = dir;
  const o = b.orient;

  if (o === "upright") {
    if (dx === 1) return { x: b.x + 1, y: b.y, orient: "flat-x" };
    if (dx === -1) return { x: b.x - 2, y: b.y, orient: "flat-x" };
    if (dy === 1) return { x: b.x, y: b.y + 1, orient: "flat-y" };
    if (dy === -1) return { x: b.x, y: b.y - 2, orient: "flat-y" };
  }
  if (o === "flat-x") {
    if (dx === 1) return { x: b.x + 2, y: b.y, orient: "upright" };
    if (dx === -1) return { x: b.x - 1, y: b.y, orient: "upright" };
    if (dy === 1) return { x: b.x, y: b.y + 1, orient: "flat-x" };
    if (dy === -1) return { x: b.x, y: b.y - 1, orient: "flat-x" };
  }
  if (o === "flat-y") {
    if (dy === 1) return { x: b.x, y: b.y + 2, orient: "upright" };
    if (dy === -1) return { x: b.x, y: b.y - 1, orient: "upright" };
    if (dx === 1) return { x: b.x + 1, y: b.y, orient: "flat-y" };
    if (dx === -1) return { x: b.x - 1, y: b.y, orient: "flat-y" };
  }
  return { x: b.x, y: b.y, orient: b.orient };
}

function tryMove(dirName) {
  if (animating || won || failed) return;
  const dir = DIRS[dirName];
  if (!dir) return;

  const block = blocks.find((b) => b.id === selectedId);
  if (!block || block.sunk) return;

  const from = { x: block.x, y: block.y, orient: block.orient };
  const next = roll(block, dir);

  // Reject invalid: off-board / unsupported / collision / taken hole.
  // Every rejection gets the same loud feedback so the rule is never a silent no-op.
  if (!isSupported(next)) return rejectMove(block, dirName, "Blocked — no floor there");
  if (collidesWithOthers(next, block.id)) return rejectMove(block, dirName, "Blocked — brick in the way");
  // Sweep: from∪to must not clip through another block mid-roll
  const sweepCells = [...footprint(from), ...footprint(next)];
  const occ = occupiedCells(block.id);
  if (sweepCells.some((ca) => occ.some((cb) => ca.x === cb.x && ca.y === cb.y)))
    return rejectMove(block, dirName, "Blocked — no room to roll");
  if (isUprightInHole(next) && holeOccupied(next.x, next.y, block.id))
    return rejectMove(block, dirName, "That hole is taken");

  moves += 1;
  updateHUD();

  // Reserve both poses so nothing else can claim these cells during the roll
  block._reserve = sweepCells;

  startRollAnim(block, from, next, dirName, () => {
    block._reserve = null;
    block.x = next.x;
    block.y = next.y;
    block.orient = next.orient;
    placeBlock(block);
    impactPunch(block, next.orient === "upright" ? 1.25 : 1);
    haptic(next.orient === "upright" ? 16 : 10);
    assertNoOverlaps("after-roll");

    if (isUprightInHole(block) && !holeOccupied(block.x, block.y, block.id)) {
      // The win check rides on the fall: the level only clears once the brick
      // has actually gone all the way down the hole.
      sinkBlock(block, checkWin);
      return;
    }

    checkWin();
  });
}

/**
 * Rejected move: bump the brick into the wall it can't cross, red-tint its
 * outline, buzz, red-vignette the frame and name the reason in the status line.
 */
function rejectMove(block, dirName, reason) {
  setStatus(reason || "Blocked", "fail", 1200);
  flashScreen("reject");
  shakeStage("soft");
  haptic([18, 30, 18]);
  nudgeBlock(block, dirName);
  tintRejected(block);
}

/** Short bump toward the illegal direction and back — reads as "wall". */
function nudgeBlock(block, dirName) {
  const dir = DIRS[dirName];
  if (!dir || !block.mesh || block.sunk || animating) return;
  const mesh = block.mesh;
  if (block._nudgeFx) cancelFx(block._nudgeFx);
  const base = poseTransform(block).position.clone();
  const amp = 0.22;
  block._nudgeFx = addFx(
    NUDGE_MS,
    (p) => {
      if (animating || block.sunk) return;
      const k = Math.sin(Math.PI * p) * (1 - 0.35 * p);
      mesh.position.set(base.x + dir.dx * amp * k, base.y, base.z + dir.dy * amp * k);
    },
    () => {
      block._nudgeFx = null;
      if (!animating && !block.sunk) mesh.position.copy(base);
    }
  );
}

/** Flash the white outline + footprint ring red, then fade back to white. */
function tintRejected(block) {
  const targets = [];
  const outline = block.mesh ? block.mesh.getObjectByName("outline") : null;
  if (outline && outline.visible) targets.push(outline.material);
  if (block.highlight && block.highlight.visible) {
    const ring = block.highlight.getObjectByName("ring");
    if (ring && ring.material) targets.push(ring.material);
  }
  if (!targets.length) return;
  if (block._rejectFx) cancelFx(block._rejectFx);
  const saved = targets.map((m) => m.color.clone());
  block._rejectFx = addFx(
    340,
    (p) => {
      const k = 1 - p;
      targets.forEach((m, i) => m.color.copy(saved[i]).lerp(REJECT_COLOR, k));
    },
    () => {
      targets.forEach((m, i) => m.color.copy(saved[i]));
      block._rejectFx = null;
    }
  );
}

/**
 * The brick loses its footing and drops straight down the hole under gravity.
 * Its clip plane rises to board level for the fall, so the floor swallows it
 * from the bottom up — the read is "falling into the void", not a shrink or a
 * pop. `onComplete` runs only once the brick is all the way in, so the win /
 * result screen never cuts the fall short.
 */
function sinkBlock(block, onComplete) {
  block.sunk = true;
  const hx = block.x;
  const hz = block.y;
  const colors = block.colors || BLOCK_COLORS[0];

  if (block.highlight) block.highlight.visible = false;
  setOutlineVisible(block, false);

  // Last brick down: stop the clock now, so the fall itself can never turn a
  // solved board into a timeout.
  if (blocks.every((b) => b.sunk)) timerRunning = false;

  // Auto-select next unsunk block
  if (selectedId === block.id) {
    const next = blocks.find((b) => !b.sunk);
    if (next) selectedId = next.id;
  }
  updateSelectionVisuals();
  updateHUD();

  // The mouth reacts the instant the brick tips in; the big hit waits for the
  // moment the board actually swallows it (swallowFx below).
  spawnShockwave(hx, hz, PALETTE.holeGlow, { from: 0.45, to: 2.2, life: 400, opacity: 0.85 });
  haptic(12);

  /** Fired the frame the brick's top edge passes below the board surface. */
  const swallowFx = () => {
    const puffY = TILE_H + 0.25;
    spawnShockwave(hx, hz, PALETTE.holeGlow, { from: 0.5, to: 3.6, life: 640, opacity: 1 });
    spawnBurst(hx, puffY, hz, colors.edge, 26, {
      life: 720,
      spread: 2.6,
      up: 3.2,
      gravity: 5.6,
      size: 0.42,
    });
    spawnBurst(hx, puffY, hz, 0xffffff, 14, {
      life: 500,
      spread: 3.4,
      up: 1.7,
      gravity: 4.6,
      size: 0.26,
    });
    window.setTimeout(() => {
      if (scene) spawnShockwave(hx, hz, 0xffffff, { from: 0.4, to: 2.5, life: 480, opacity: 0.85 });
    }, 110);
    shakeStage("soft");
    haptic([22, 40, 30]);
    flashScreen("sink");
    setStatus(`Sunk! ${sunkCount()}/${blocks.length}`, "info", 1600);
  };

  if (!block.mesh) {
    swallowFx();
    if (onComplete) onComplete();
    return;
  }

  const mesh = block.mesh;
  if (block._punchFx) cancelFx(block._punchFx);
  if (block._nudgeFx) cancelFx(block._nudgeFx);
  if (block._sinkFx) cancelFx(block._sinkFx);
  mesh.scale.set(1, 1, 1);

  const y0 = mesh.position.y;
  const q0 = mesh.quaternion.clone();
  // Drop needed before the brick's top edge is under the board surface. Half of
  // the 1.96-tall body plus its bevel, so this holds for any pose it sinks from.
  const swallowDrop = Math.max(0.5, y0 + 1 - SINK_CLIP_Y);
  // Which way it topples going over the lip — a few degrees, just enough to
  // sell weight without ever hiding the brick's face from the top-down camera.
  const tiltAxis = new THREE.Vector3(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
  if (tiltAxis.lengthSq() < 1e-4) tiltAxis.set(1, 0, 0);
  tiltAxis.normalize();
  const tiltQ = new THREE.Quaternion();

  if (block.clipPlane) block.clipPlane.constant = -SINK_CLIP_Y;
  let swallowed = false;

  block._sinkFx = addFx(
    SINK_MS,
    (p) => {
      const t = p * SINK_MS;
      let drop;
      let tilt;
      if (t < SINK_TIP_MS) {
        // Tipping in: dips into the mouth, gravity has barely taken hold.
        const k = t / SINK_TIP_MS;
        drop = SINK_TIP_DROP * k * k;
        tilt = SINK_TILT * 0.3 * k * k;
      } else {
        // Free fall — distance grows with t^2, i.e. constant gravity. k runs
        // past 1 during the tail, so the brick keeps accelerating out of sight
        // instead of stopping dead the moment it is hidden.
        const k = (t - SINK_TIP_MS) / SINK_FALL_MS;
        drop = SINK_TIP_DROP + (swallowDrop - SINK_TIP_DROP) * k * k;
        tilt = SINK_TILT * Math.min(1, 0.3 + 0.7 * k);
      }
      mesh.position.y = y0 - drop;
      tiltQ.setFromAxisAngle(tiltAxis, tilt);
      mesh.quaternion.copy(tiltQ).multiply(q0);
      if (!swallowed && drop >= swallowDrop) {
        swallowed = true;
        swallowFx();
      }
    },
    (cancelled) => {
      block._sinkFx = null;
      if (block.clipPlane) block.clipPlane.constant = CLIP_PARKED;
      mesh.visible = false;
      mesh.position.y = y0;
      mesh.quaternion.copy(q0);
      mesh.scale.set(1, 1, 1);
      if (cancelled) return; // level swapped out mid-fall — no win check
      if (!swallowed) swallowFx();
      if (onComplete) onComplete();
    }
  );
}

function checkWin() {
  if (won || failed) return;
  if (blocks.length > 0 && blocks.every((b) => b.sunk)) {
    won = true;
    timerRunning = false;
    setStatus("Level clear!", "win");
    flashScreen("win");
    celebratePulse();
    const hasNext = levelIndex < levels.length - 1;
    showResult({
      title: hasNext ? "Level clear!" : "You win!",
      sub: hasNext
        ? `${moves} moves · ${formatTime(timeLeft)} left`
        : "You beat every level.",
      cta: hasNext ? "Next" : "Replay",
      kind: "win",
      action: hasNext ? "next" : "done",
    });
  }
}

function onTimeout() {
  if (won || failed) return;
  failed = true;
  timerRunning = false;
  timeLeft = 0;
  updateHUD();
  setStatus("Time's up!", "fail");
  flashScreen("fail");
  shakeStage();
  showResult({
    title: "Time's up!",
    sub: "Try again — roll faster.",
    cta: "Retry",
    kind: "fail",
    action: "retry",
  });
}

function hardRestart() {
  loadLevel(levelIndex);
}

function applyStudsVisibility() {
  for (const b of blocks) {
    if (b.studGroup) b.studGroup.visible = showStuds;
  }
  if (cols && rows) {
    buildBoard();
    for (const b of blocks) placeBlock(b);
    updateSelectionVisuals();
  }
  if (btnStuds) {
    btnStuds.textContent = showStuds ? "Studs: On" : "Studs: Off";
    btnStuds.setAttribute("aria-pressed", showStuds ? "true" : "false");
  }
}

// --- Animation ---
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Tipping over: hangs at the balance point, then gravity yanks it down. */
function easeTip(t) {
  return t * t * (2.2 - 1.2 * t);
}

/** Standing up: needs a shove, then settles heavy onto its end. */
function easeRise(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Flat side roll: light, snappy, symmetric. */
function easeSide(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Duration + curve follow what the brick is physically doing. */
function rollStyle(fromOrient, toOrient) {
  if (fromOrient === "upright") return { ms: ROLL_MS_TIP, ease: easeTip };
  if (toOrient === "upright") return { ms: ROLL_MS_RISE, ease: easeRise };
  return { ms: ROLL_MS_SIDE, ease: easeSide };
}

function startRollAnim(block, from, to, dirName, onDone) {
  // Any leftover bump / squash would fight the pivot transform
  if (block._nudgeFx) cancelFx(block._nudgeFx);
  if (block._punchFx) cancelFx(block._punchFx);
  block.x = from.x;
  block.y = from.y;
  block.orient = from.orient;
  placeBlock(block);

  const info = getRollPivot(from, dirName);
  if (!info) {
    block._reserve = null;
    block.x = to.x;
    block.y = to.y;
    block.orient = to.orient;
    placeBlock(block);
    onDone();
    return;
  }

  animating = true;
  clearPivot();
  pivot = new THREE.Object3D();
  pivot.position.copy(info.pivot);
  scene.add(pivot);
  pivot.attach(block.mesh);

  const style = rollStyle(from.orient, to.orient);
  anim = {
    kind: "roll",
    block,
    t0: performance.now(),
    duration: style.ms,
    ease: style.ease,
    axis: info.axis.clone(),
    angle: info.angle,
    onDone,
  };
}

function updateAnim(now) {
  if (!anim) return;
  const raw = Math.min(1, (now - anim.t0) / anim.duration);
  const t = (anim.ease || easeInOut)(raw);

  if (anim.kind === "roll" && pivot) {
    pivot.quaternion.setFromAxisAngle(anim.axis, anim.angle * t);
  }

  if (raw >= 1) {
    const done = anim.onDone;
    anim = null;
    animating = false;
    clearPivot();
    if (done) done();
  }
}

function updateTimer(now) {
  if (!timerRunning || won || failed) return;
  if (
    (howto && !howto.classList.contains("hidden")) ||
    (elResult && !elResult.classList.contains("hidden"))
  ) {
    lastTick = now;
    return;
  }
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    updateHUD();
    onTimeout();
  } else {
    // throttle HUD text to ~10Hz
    if (!updateTimer._acc) updateTimer._acc = 0;
    updateTimer._acc += dt;
    if (updateTimer._acc >= 0.1) {
      updateTimer._acc = 0;
      updateHUD();
    }
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  updateAnim(now);
  updateFx(now);
  updateTimer(now);
  // Soft pulse on selected ring / glow
  const sel = blocks.find((b) => b.id === selectedId && !b.sunk && b.highlight);
  if (sel && sel.highlight) {
    const wave = Math.sin(now * 0.008);
    const pulse = 0.88 + 0.12 * wave;
    const ring = sel.highlight.getObjectByName("ring");
    const glow = sel.highlight.getObjectByName("glow");
    if (ring && ring.material) ring.material.opacity = 0.75 + 0.2 * pulse;
    if (glow && glow.material) glow.material.opacity = 0.18 + 0.16 * pulse;
    // Breathe the white shell so the selected brick is unmistakable on a small screen
    const outline = sel.mesh ? sel.mesh.getObjectByName("outline") : null;
    if (outline && outline.visible && outline.material) {
      outline.material.opacity = 0.85 + 0.15 * pulse;
      const s = 1 + 0.02 * wave;
      outline.scale.set(s, s, s);
    }
  }
  renderer.render(scene, camera);
}

// --- Selection / picking ---
function selectBlock(id) {
  const b = blocks.find((x) => x.id === id && !x.sunk);
  if (!b) return;
  selectedId = id;
  updateSelectionVisuals();
}

function clientToNDC(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

/** Pick block under pointer via raycast against meshes, fallback to footprint projection. */
function pickBlockAt(clientX, clientY) {
  clientToNDC(clientX, clientY);
  raycaster.setFromCamera(pointerNDC, camera);

  const meshes = [];
  for (const b of blocks) {
    if (b.sunk || !b.mesh || !b.mesh.visible) continue;
    b.mesh.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
  }
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length) {
    let obj = hits[0].object;
    while (obj && (obj.userData.blockId === undefined)) obj = obj.parent;
    if (obj && obj.userData.blockId !== undefined) return obj.userData.blockId;
  }

  // Footprint fallback: project pointer onto y=TILE_H plane
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TILE_H);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const gx = hit.x;
  const gz = hit.z;

  let best = null;
  let bestDist = Infinity;
  for (const b of blocks) {
    if (b.sunk) continue;
    for (const c of footprint(b)) {
      const d = (gx - c.x) * (gx - c.x) + (gz - c.y) * (gz - c.y);
      if (d < bestDist && d < 0.55 * 0.55) {
        bestDist = d;
        best = b.id;
      }
    }
  }
  return best;
}

// --- Controls ---
const keyMap = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

window.addEventListener("keydown", (e) => {
  if (howto && !howto.classList.contains("hidden")) return;
  if (elResult && !elResult.classList.contains("hidden")) return;
  const dir = keyMap[e.key];
  if (dir) {
    e.preventDefault();
    tryMove(dir);
  }
  if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    hardRestart();
  }
  // Tab / number keys to cycle selection
  if (e.key === "Tab") {
    e.preventDefault();
    const active = blocks.filter((b) => !b.sunk);
    if (!active.length) return;
    const idx = active.findIndex((b) => b.id === selectedId);
    const next = active[(idx + 1) % active.length];
    selectBlock(next.id);
  }
  if (e.key >= "1" && e.key <= "9") {
    const id = parseInt(e.key, 10) - 1;
    selectBlock(id);
  }
});

document.querySelectorAll("[data-dir]").forEach((btn) => {
  const fire = (e) => {
    e.preventDefault();
    tryMove(btn.getAttribute("data-dir"));
  };
  btn.addEventListener("pointerdown", fire);
});

let touchStart = null;
const SWIPE_MIN = 28;

function onPointerDown(e) {
  if (
    e.target.closest(".dpad") ||
    e.target.closest(".toolbar") ||
    e.target.closest(".sheet") ||
    e.target.closest(".overflow") ||
    e.target.closest(".topbar")
  )
    return;
  const picked = pickBlockAt(e.clientX, e.clientY);
  if (picked !== null && picked !== undefined) {
    selectBlock(picked);
  }
  touchStart = { x: e.clientX, y: e.clientY, id: e.pointerId, picked };
}

function onPointerUp(e) {
  if (!touchStart || touchStart.id !== e.pointerId) return;
  const dx = e.clientX - touchStart.x;
  const dy = e.clientY - touchStart.y;
  const startedOn = touchStart.picked;
  touchStart = null;

  // Tap (no swipe): just select
  if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;

  // Swipe moves the block that was under the finger (or current selection)
  if (startedOn !== null && startedOn !== undefined) {
    selectBlock(startedOn);
  }

  if (Math.abs(dx) > Math.abs(dy)) {
    tryMove(dx > 0 ? "right" : "left");
  } else {
    tryMove(dy > 0 ? "down" : "up");
  }
}

function onPointerCancel() {
  touchStart = null;
}

canvas.addEventListener("pointerdown", onPointerDown);
stage.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerCancel);

document.body.addEventListener(
  "touchmove",
  (e) => {
    if (!e.target.closest(".howto-body") && !e.target.closest(".sheet-card")) e.preventDefault();
  },
  { passive: false }
);

btnRestart.addEventListener("click", () => {
  closeOverflow();
  hideResult();
  hardRestart();
});

if (btnHowto) {
  btnHowto.addEventListener("click", () => {
    closeOverflow();
    showHowto(true);
  });
}

btnHowtoClose.addEventListener("click", () => {
  howto.classList.add("hidden");
  lastTick = performance.now();
  try {
    localStorage.setItem("bloxorz3d-howto-seen", "1");
  } catch (_) {}
});

if (btnStuds) {
  btnStuds.addEventListener("click", () => {
    showStuds = !showStuds;
    applyStudsVisibility();
    closeOverflow();
  });
}

if (btnOverflow && overflowMenu) {
  btnOverflow.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = overflowMenu.classList.toggle("hidden") === false;
    btnOverflow.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("pointerdown", (e) => {
    if (!overflowMenu.classList.contains("hidden")) {
      if (!e.target.closest(".overflow")) closeOverflow();
    }
  });
}

if (btnResultCta) {
  btnResultCta.addEventListener("click", () => {
    const action = pendingResultAction;
    hideResult();
    if (action === "next") {
      loadLevel(levelIndex + 1);
      setStatus("Next level!", "info");
    } else if (action === "retry") {
      loadLevel(levelIndex);
    } else if (action === "done") {
      loadLevel(0);
      setStatus("Play again!", "info");
    }
  });
}

// Stronger press feedback on buttons / d-pad
function wirePressFeedback(root) {
  root.querySelectorAll("button").forEach((btn) => {
    const down = () => btn.classList.add("is-pressed");
    const up = () => btn.classList.remove("is-pressed");
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
  });
}
wirePressFeedback(document);

function showHowto(force) {
  let seen = false;
  try {
    seen = localStorage.getItem("bloxorz3d-howto-seen") === "1";
  } catch (_) {}
  if (force || !seen) howto.classList.remove("hidden");
  else howto.classList.add("hidden");
}

window.addEventListener("resize", resize);

// --- Boot ---
initThree();
showHowto(false);
loadLevel(0);
if (btnStuds) {
  btnStuds.textContent = "Studs: Off";
  btnStuds.setAttribute("aria-pressed", "false");
}

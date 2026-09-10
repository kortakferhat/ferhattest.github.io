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
const ROLL_MS = 220;
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
    if (o.geometry) o.geometry.dispose();
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
      _reserve: null,
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

function setStatus(msg, kind) {
  if (!elStatus) return;
  elStatus.textContent = msg || "";
  elStatus.className = "status sr-status" + (kind ? " " + kind : "");
}

// --- Juice (CSS class hooks; no physics changes) ---
function flashScreen(kind = "sink") {
  if (!elFxFlash) return;
  elFxFlash.classList.remove("on", "sink", "fail", "win");
  // reflow so animation restarts
  void elFxFlash.offsetWidth;
  elFxFlash.classList.add("on", kind);
  window.setTimeout(() => {
    elFxFlash.classList.remove("on", "sink", "fail", "win");
  }, 380);
}

function shakeStage() {
  if (!stage) return;
  stage.classList.remove("fx-shake");
  void stage.offsetWidth;
  stage.classList.add("fx-shake");
  window.setTimeout(() => stage.classList.remove("fx-shake"), 450);
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

function impactPunch(block) {
  if (!block || !block.mesh || block.sunk) return;
  block.mesh.scale.set(1.07, 0.93, 1.07);
  window.setTimeout(() => {
    if (block.mesh && block.mesh.visible && !block.sunk) {
      block.mesh.scale.set(1, 1, 1);
    }
  }, 75);
}

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

  const studGroup = new THREE.Group();
  studGroup.name = "blockStuds";
  const studMat = plasticMat(colors.stud, { roughness: 0.3, clearcoat: 0.85 });
  studGroup.add(makeStudCluster(studMat, 0.98));
  studGroup.visible = showStuds;
  group.add(studGroup);

  scene.add(group);
  b.mesh = group;
  b.studGroup = studGroup;

  // World-space selection ring + soft glow disc (stays flat under footprint)
  const hlGroup = new THREE.Group();
  hlGroup.name = "selectRing";
  hlGroup.userData.blockId = b.id;
  hlGroup.visible = false;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.78, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.name = "ring";
  hlGroup.add(ring);

  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 32),
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
  // Scale ring to footprint span (wider when flat)
  const span = Math.max(1, cells.length);
  b.highlight.scale.set(0.85 + span * 0.22, 1, 0.85 + span * 0.22);
  b.highlight.position.set(cx, TILE_H + 0.045, cz);
}

function updateSelectionVisuals() {
  for (const b of blocks) {
    if (b.highlight) {
      b.highlight.visible = !b.sunk && b.id === selectedId;
      if (b.highlight.visible) updateHighlightPos(b);
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

  // Reject invalid: off-board / unsupported / collision / taken hole
  if (!isSupported(next)) return;
  if (collidesWithOthers(next, block.id)) return;
  // Sweep: from∪to must not clip through another block mid-roll
  const sweep = { x: from.x, y: from.y, orient: from.orient };
  const sweepCells = [...footprint(from), ...footprint(next)];
  const occ = occupiedCells(block.id);
  if (sweepCells.some((ca) => occ.some((cb) => ca.x === cb.x && ca.y === cb.y))) return;
  if (isUprightInHole(next) && holeOccupied(next.x, next.y, block.id)) return;

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
    impactPunch(block);
    assertNoOverlaps("after-roll");

    if (isUprightInHole(block) && !holeOccupied(block.x, block.y, block.id)) {
      sinkBlock(block);
    }

    checkWin();
  });
}

function sinkBlock(block) {
  block.sunk = true;
  if (block.mesh) {
    // Drop slightly into hole and hide
    block.mesh.position.y = TILE_H + 0.35;
    block.mesh.visible = false;
  }
  if (block.highlight) block.highlight.visible = false;

  // Auto-select next unsunk block
  if (selectedId === block.id) {
    const next = blocks.find((b) => !b.sunk);
    if (next) selectedId = next.id;
  }
  updateSelectionVisuals();
  updateHUD();
  flashScreen("sink");
  setStatus(`Sunk! ${sunkCount()}/${blocks.length}`, "info");
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

function startRollAnim(block, from, to, dirName, onDone) {
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

  anim = {
    kind: "roll",
    block,
    t0: performance.now(),
    duration: ROLL_MS,
    axis: info.axis.clone(),
    angle: info.angle,
    onDone,
  };
}

function updateAnim(now) {
  if (!anim) return;
  const raw = Math.min(1, (now - anim.t0) / anim.duration);
  const t = easeInOut(raw);

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
  updateTimer(now);
  // Soft pulse on selected ring / glow
  const sel = blocks.find((b) => b.id === selectedId && !b.sunk && b.highlight);
  if (sel && sel.highlight) {
    const pulse = 0.88 + 0.12 * Math.sin(now * 0.008);
    const ring = sel.highlight.getObjectByName("ring");
    const glow = sel.highlight.getObjectByName("glow");
    if (ring && ring.material) ring.material.opacity = 0.75 + 0.2 * pulse;
    if (glow && glow.material) glow.material.opacity = 0.18 + 0.16 * pulse;
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

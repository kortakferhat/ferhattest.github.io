# Bloxorz 3D (Three.js HTML5 prototype)

Portrait mobile Bloxorz-style puzzle in true 3D: roll **multiple 1×1×2** bricks into holes **while upright**, before the timer expires.

**Visual language:** Lego / Block Out plastic bricks (beveled `RoundedBoxGeometry`, `MeshPhysicalMaterial` clearcoat, soft shadows). Yellow tiles, colored player bricks, blue hole rims. Optional **Studs** toggle (default off). Camera is **top-down** (not isometric) so screen swipe maps 1:1 to the grid.

## Open / play

**Network required** — Three.js loads from the CDN (`unpkg.com` via import map).

```bash
cd /workspace/bloxorz-3d
python3 -m http.server 8081
# visit http://localhost:8081
```

Opening `index.html` as `file://` often fails for ES modules / import maps; use the server above.

Resize to phone width (~420px) or use device emulation for the portrait frame.

## Controls

- **Tap** a block to select (white ring highlight)
- **Swipe** starting on a block moves **that** block only
- **D-pad** / **arrow keys** (WASD) move the selected block
- **Tab** or **1–9** to change selection
- **Restart** button or **R**
- First-load **How to play** overlay (timer pauses while open)

## Locked rules

1. **No falling** — invalid moves (off board / unsupported tiles / overlap) are rejected; the block stays put. Boards are contiguous playfields.
2. **N blocks ↔ N holes** — win only when **every** hole has a block **upright** on it (flat over a hole does not sink).
3. **Timer** — default **120 seconds** (`timeLimit` per level). Win if all sunk before time; timeout fails and restarts.
4. **3+ levels** of increasing difficulty (2 → 3 → 4 blocks).
5. **Per-block input** — pointer down picks the block under the finger (raycast + footprint fallback).

## Files

| File | Role |
|------|------|
| `index.html` | Shell / UI + Three.js import map (timer + blocks remaining HUD) |
| `styles.css` | Portrait mobile layout (~420px) |
| `game.js` | Three.js scene, multi-block rolls, timer, selection, win/fail |
| `levels.js` | Editable grids: `0` empty, `1` tile, `2` hole, `S`/`A`/`B`… starts |

### Level format

```js
{
  id: 1,
  name: "Twin Drops",
  timeLimit: 120, // optional, default 120
  grid: [
    "1111111",
    "1S111A1",  // S, A, B… = start positions (solid)
    "1112111",  // 2 = hole (also solid support)
  ],
  // optional override: starts: [{x,y}, {x,y}]
}
```

Add levels by appending to `window.BLOXORZ_LEVELS`.

## Mechanics

- Orientations: **upright** (1×1), **flat-x** (1×2), **flat-y** (2×1)
- Tip/slide 90° roll pivots (~220ms)
- Blocks cannot occupy the same footprint; sunk blocks leave the playfield
- Only fail condition: **timeout** (restart)

## Stack

- Three.js **r170** via `unpkg` + import map (no npm / bundler)
- Plain ES module `game.js`

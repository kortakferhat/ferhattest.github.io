/**
 * Bloxorz levels — editable grid data (multi-block, no-fall playfields).
 *
 * Legend:
 *   0 = empty / off-board (moves onto these are REJECTED; block stays)
 *   1 = solid tile
 *   2 = hole (counts as solid support; win when a block is upright on it)
 *   S, A, B, C… = start positions (become solid tiles; one block each)
 *     Order of discovery: S first, then A, B, C… (row-major scan)
 *   Optional: level.starts = [{x,y}, …] overrides letter starts
 *   Optional: level.timeLimit = seconds (default 120)
 *
 * Assume N starts and N holes (1:1). Win when every hole has a block upright on it.
 * Boards are contiguous solid-ish platforms — no sparse death drops.
 *
 * Rows are Y (north→south), columns are X (west→east).
 * Levels 2–5 locked by design (Ibrahim Abi); Level 1 Twin Drops kept.
 */
window.BLOXORZ_LEVELS = [
  {
    id: 1,
    name: "Twin Drops",
    timeLimit: 120,
    grid: [
      "1111111",
      "1S111A1",
      "1111111",
      "1112111",
      "1111111",
      "1112111",
      "1111111",
    ],
  },
  {
    id: 2,
    name: "Hall Pass",
    timeLimit: 120,
    grid: [
      "1111111",
      "1S11111",
      "1110111",
      "1112111",
      "1110111",
      "11111A1",
      "1112111",
      "1111111",
    ],
  },
  {
    id: 3,
    name: "Triple Park",
    timeLimit: 120,
    grid: [
      "111111111",
      "1S1111111",
      "111111111",
      "111121111",
      "111111111",
      "1A11111B1",
      "111111111",
      "111121111",
      "111111111",
      "111121111",
      "111111111",
    ],
  },
  {
    id: 4,
    name: "Squeeze",
    timeLimit: 120,
    grid: [
      "111111111",
      "1S11111A1",
      "111011111",
      "111211111",
      "111011111",
      "111111011",
      "111111211",
      "1B1111011",
      "111111111",
      "111111211",
      "111111111",
    ],
  },
  {
    id: 5,
    name: "Quad Relay",
    timeLimit: 150,
    grid: [
      "11111111111",
      "1S1111111A1",
      "11111111111",
      "11112111111",
      "11111111111",
      "11111121111",
      "11111111111",
      "11111211111",
      "11111111111",
      "1B1111111C1",
      "11111111111",
      "11111112111",
      "11111111111",
    ],
  },
];

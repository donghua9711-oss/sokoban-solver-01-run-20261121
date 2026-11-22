// sokoban-solver: a push-optimal Sokoban solver for sokoban-solver-01.
//
// How it works. The levels this contest draws are a hallway with small rooms off it: a box pushed
// into the hallway can never come back (the square past the hallway on a door's line is always
// wall), so every box stays in its own room and the level's push optimum is the sum of its rooms'
// optima. This solver finds the rooms by cutting the dead squares (squares from which no box can
// ever reach a goal) out of the player's row, then solves each room on its own with a breadth-first
// search over pushes -- a state is the boxes' squares plus the player's reachable region, named by
// its lowest square -- which meets the room's push optimum first. Two prunings keep the search
// small without ever cutting a solvable state: a push onto a dead square is dropped, and a push
// that freezes a 2 x 2 block of walls and boxes with a box off its goal is dropped. The other
// rooms' boxes stand as walls while a room is solved, and the player's walk between pushes is a
// shortest path, so the rooms' solutions join into one move string for the whole level.
//
// Every budget below is a count of states, never the clock, and the direction order is fixed, so
// the program answers alike on every run. A search that runs past its budget gives up on that
// level (an empty, valid answer) rather than guessing.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, the walk's letter, the push's letter]. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** State budgets: per room search, per whole-level fallback search, and across the whole run. */
const ROOM_STATE_CAP = 900_000;
const WHOLE_STATE_CAP = 400_000;
const RUN_EXPANSION_BUDGET = 6_000_000;

/**
 * A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on
 * a goal): its width and height, walls (short rows and the outermost frame read as walls), goals,
 * boxes and player.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can still be pushed onto some goal, found by pulling boxes
 * back from the goals over open floor. A box on any other square can never be solved.
 */
function liveSquares(w, wall, goals) {
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (y < 0 || y >= size) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Whether the box just pushed to `t` sits frozen in a 2 x 2 block of walls and boxes, a box of it off its goal. */
function frozenBlock(w, wall, occupied, goalSet, t) {
  const solid = (i) => wall[i] === 1 || occupied[i] === 1;
  const offGoal = (i) => occupied[i] === 1 && goalSet[i] === 0;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!solid(a) || !solid(b) || !solid(c) || !solid(d)) continue;
    if (offGoal(a) || offGoal(b) || offGoal(c) || offGoal(d)) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and the boxes in `occupied`, in lower letters, or null. */
function walkPath(w, wall, occupied, from, to) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size);
  const queue = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  prev[from] = from;
  while (qh < qt) {
    const p = queue[qh++];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue[qt++] = q;
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = DIRS[how[p]][2] + s;
  return s;
}

/** The square the player stands on after playing `moves` (either case) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of one board: breadth-first over pushes, at most `cap` states kept and
 * at most `budget.left` states expanded. A state is the boxes' squares and the lowest square of
 * the player's reachable region; expanding states in the order found meets a solved state first at
 * the fewest pushes. Returns { pushes, moves } (moves in LURD, an upper letter a push) or null when
 * the search gives up or the board cannot be solved.
 */
function solvePushOptimal(w, wall, goals, startBoxes, startPlayer, cap, budget) {
  const size = wall.length;
  const n = startBoxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  const isGoal = (boxes) => boxes.every((b) => goalSet[b] === 1);
  if (isGoal(startBoxes)) return { pushes: 0, moves: '' };
  if (startBoxes.some((b) => !live[b])) return null;

  // A state's key packs the region's lowest square and the boxes' squares as digits in base
  // `size`, exact while size ** (n + 1) stays under 2 ** 53; wider boards key on a string instead.
  const packable = Math.pow(size, n + 1) < 9007199254740992;
  const pack = (boxes, low) => {
    let k = low;
    for (let i = 0; i < n; i++) k = k * size + boxes[i];
    return k;
  };
  const unpack = (k) => {
    const boxes = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      boxes[i] = k % size;
      k = Math.floor(k / size);
    }
    return boxes;
  };
  const keyOf = packable ? pack : (boxes, low) => `${low}|${boxes.join(',')}`;
  const storedOf = packable ? (boxes) => pack(boxes, 0) : (boxes) => boxes;
  const boxesOf = packable ? unpack : (stored) => stored;

  // Flood fill scratch: `seen` marks the region of the current stamp; a flood returns its lowest square.
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const flood = (occupied, from) => {
    stamp++;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seen[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      let q = p - w;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) { seen[q] = stamp; stack[sp++] = q; }
      q = p + w;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) { seen[q] = stamp; stack[sp++] = q; }
      q = p - 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) { seen[q] = stamp; stack[sp++] = q; }
      q = p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) { seen[q] = stamp; stack[sp++] = q; }
    }
    return low;
  };

  const occupied = new Uint8Array(size);
  const stored = [];
  const statePlayer = [];
  const stateParent = [];
  const index = new Map();
  for (const b of startBoxes) occupied[b] = 1;
  index.set(keyOf(startBoxes, flood(occupied, startPlayer)), 0);
  stored.push(storedOf(startBoxes.slice()));
  statePlayer.push(startPlayer);
  stateParent.push(-1);
  occupied.fill(0);

  let found = -1;
  for (let head = 0; head < stored.length && found < 0; head++) {
    if (budget.left-- <= 0) return null;
    const boxes = boxesOf(stored[head]);
    for (const b of boxes) occupied[b] = 1;
    flood(occupied, statePlayer[head]);
    const here = stamp;
    // First collect every push this region allows, while `seen` still marks the region.
    const cands = [];
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const target = b + d;
        if (seen[b - d] !== here) continue;
        if (wall[target] || occupied[target] || !live[target]) continue;
        cands.push([bi, b, d, target]);
      }
    }
    for (const [bi, b, d, target] of cands) {
      occupied[b] = 0;
      occupied[target] = 1;
      if (!frozenBlock(w, wall, occupied, goalSet, target)) {
        const nb = boxes.slice();
        nb[bi] = target;
        nb.sort((x, y) => x - y);
        const key = keyOf(nb, flood(occupied, b));
        if (!index.has(key)) {
          if (stored.length >= cap) {
            occupied.fill(0);
            return null;
          }
          index.set(key, stored.length);
          stored.push(storedOf(nb));
          statePlayer.push(b);
          stateParent.push(head);
          if (isGoal(nb)) found = stored.length - 1;
        }
      }
      occupied[target] = 0;
      occupied[b] = 1;
      if (found >= 0) break;
    }
    occupied.fill(0);
  }
  if (found < 0) return null;

  // The path of states back to the start, then the moves: walk to each push's stance, then push.
  const path = [];
  for (let s = found; s > 0; s = stateParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const nb = boxesOf(stored[s]);
    let from = -1;
    let to = -1;
    for (const b of boxes) if (!nb.includes(b)) from = b;
    for (const b of nb) if (!boxes.includes(b)) to = b;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    const walk = walkPath(w, wall, occupied, player, from - d);
    occupied.fill(0);
    if (walk === null) return null;
    moves += walk + dir[3];
    player = from;
    boxes = nb;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no
 * goal) out of the floor, and each part left that holds a box is a room, with its boxes and goals.
 * Null when the level is no such set of rooms: a box starting in the hallway, a goal in no part, or
 * a part holding more or fewer boxes than goals.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const live = liveSquares(w, wall, goals);
  const rowStart = Math.floor(player / w) * w;
  const cut = new Uint8Array(size);
  for (let i = rowStart; i < rowStart + w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const q of [p - w, p + w, p - 1, p + 1]) {
        if (q < 0 || q >= size || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const out = rooms.filter((r) => r.boxes.length > 0);
  for (const r of out) {
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
  }
  return out;
}

/** One run's shared expansion budget, so the whole set stays inside its wall on counts alone. */
const budget = { left: RUN_EXPANSION_BUDGET };

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push). */
function solve(text) {
  const level = parseLevel(text);
  const goalSet = new Set(level.goals);
  if (level.boxes.every((b) => goalSet.has(b))) return '';
  const rooms = roomsOf(level);
  if (rooms !== null) {
    // Each room in turn, the other rooms' boxes standing as walls where they rest (their start
    // squares before their turn, their goals after it); the player walks on from room to room.
    const resting = rooms.map((r) => r.boxes);
    let player = level.player;
    let moves = '';
    let joined = true;
    for (let i = 0; i < rooms.length; i++) {
      const wall = level.wall.slice();
      for (let j = 0; j < rooms.length; j++) {
        if (j === i) continue;
        for (const b of resting[j]) wall[b] = 1;
      }
      const solved = solvePushOptimal(level.w, wall, rooms[i].goals, rooms[i].boxes, player, ROOM_STATE_CAP, budget);
      if (solved === null) {
        joined = false;
        break;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      resting[i] = rooms[i].goals;
    }
    if (joined) return moves;
  }
  const whole = solvePushOptimal(level.w, level.wall, level.goals, level.boxes, level.player, WHOLE_STATE_CAP, budget);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

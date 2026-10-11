#!/usr/bin/env node
// Super Mario Bros-styled GitHub contribution graph generator (v2).
// Zero dependencies, Node 22+, ESM. Output is a self-contained animated SVG
// (pure CSS @keyframes, no JS, no external fonts/images) suitable for <img>.
//
//   node .github/mario/mario-graph.mjs --user <login> --out dist [--data contrib.json]
//
// Without --data, the calendar is fetched from the GitHub GraphQL API using
// the GITHUB_TOKEN environment variable.
//
// How the level plays:
//  * Mario rises out of the left warp pipe as small Mario, bumps an intro
//    "?" block and grabs its mushroom to become Super Mario.
//  * He then walks the lane left to right. Every contribution cell is hit by
//    exactly one jump. Columns are cleared bottom-up; at the top of each jump
//    his head touches the bottom edge of the lowest solid block in that column.
//    Normally that is the target itself. Once a "?" block has turned into a
//    used block it stays solid and can't be passed, so blocks stacked on top of
//    it are reached by bumping the used block from below: the bump travels up
//    the touching stack and pops its top-most un-hit block (Newton's-cradle
//    style). Popping from the top never strands a block above an empty gap.
//    Blocks that do float above a used block with empty cells between are
//    reached by riding a lift up the neighbouring (empty) column, stepping onto
//    the used block and jumping from there, ducking if the gap is one cell.
//    Only if no neighbour is clear does the bump carry across the gap
//    (the CLI prints how often that fallback was needed).
//  * Targets out of reach from the ground (max jump about 4 cells) are reached
//    with an orange lift. It sits flush in the ground under that week and
//    carries Mario up through empty space only.
//  * Goombas get stomped. A Koopa gets stomped and kicked, and its shell slides
//    through more Goombas (100, 200, 400, 800) before dropping into a pit that
//    Mario jumps over.
//  * Mario hops onto the right pipe and sinks into it. Everything is restored
//    during the last 3% of the loop.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------- data ----

const QUERY = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{contributionCount contributionLevel weekday date}}}}}}`;

async function fetchCalendar(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set (or pass --data <file.json>)');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'mario-contribution-graph' },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractCalendar(json) {
  if (json?.errors?.length) throw new Error('GraphQL errors: ' + JSON.stringify(json.errors));
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal?.weeks) throw new Error('Unexpected response shape: contributionCalendar missing');
  return cal;
}

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// ------------------------------------------------------------- layout ----

const CELL = 12;
const PITCH = 15;
const GX = 50; // grid left (room for the left warp pipe + intro block)
const GY = 36; // grid top (HUD strip + coin headroom above)
const GRID_BOTTOM = GY + 6 * PITCH + CELL; // 138
const GROUND = GRID_BOTTOM + 45; // 183: lane is 3 cells tall
const GROUND_H = 16;
const HEIGHT = GROUND + GROUND_H;
const PIPE_H = 30;
const SPR = 0.9375; // sprite pixel scale (16px sprite -> 15px = one cell pitch)
const H_SMALL = 15;
const H_BIG = 30;
const HW_SMALL = 5.625; // half widths
const HW_BIG = 7.5;
const JMAX = 60; // max jump height (4 cells)
const J_LIFT = 21; // hop height when jumping off a lift
const GRAV = 926; // px/s^2 -> a 60px jump rises in ~0.36s
const V_RUN = 78; // px/s
const V_LIFT = 85;
const V_SHELL = 240;
const GOOMBA_H = 15;
const KOOPA_H = 17;
const SHELL_H = 11;
const RESTORE = 0.97;
const HOLD_END = 1.2;
const TARGET_T = 48; // aim for <= this many seconds
const MAX_T = 60;

const cellTop = (r) => GY + r * PITCH;
const cellBottom = (r) => GY + r * PITCH + CELL;
const colX = (c) => GX + c * PITCH;
const colCx = (c) => GX + c * PITCH + 6;

// --------------------------------------------------------------- themes ----

const THEMES = {
  light: {
    bg: '#5c94fc', empty: '#ffffff', emptyOp: 0.18,
    brick: ['#d8703a', '#c84c0c'], mortar: '#000000', hi: '#fcbcb0',
    q: '#fca044', qDark: '#000000', qGlyph: '#7c2800', used: '#9c4a00', coin: '#fcd000',
    ground: '#c84c0c', groundMortar: '#000000', groundHi: '#fcbcb0',
    cloud: '#ffffff', cloudOp: 1, hud: '#ffffff',
  },
  dark: {
    bg: '#0d1117', empty: '#161b22', emptyOp: 1,
    brick: ['#1d4a8f', '#2860b8'], mortar: '#0a1630', hi: '#6fa0ff',
    q: '#fca044', qDark: '#000000', qGlyph: '#7c2800', used: '#9c4a00', coin: '#fcd000',
    ground: '#1d4a8f', groundMortar: '#0a1630', groundHi: '#6fa0ff',
    cloud: '#8b949e', cloudOp: 0.18, hud: '#e6edf3',
  },
};

// ------------------------------------------------------------- sprites ----

function pixelArt(rows, palette) {
  const byColor = {};
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (!palette[ch]) { x++; continue; }
      let len = 1;
      while (row[x + len] === ch) len++;
      (byColor[ch] ??= []).push(`M${x} ${y}h${len}v1h-${len}z`);
      x += len;
    }
  });
  return Object.entries(byColor).map(([ch, d]) => `<path fill="${palette[ch]}" d="${d.join('')}"/>`).join('');
}

const SMALL_TOP = [
  '...RRRRR....',
  '..RRRRRRRRR.',
  '..BBBSSBS...',
  '.BSBSSSBSSS.',
  '.BSBBSSSBSSS',
  '.BBSSSSBBBB.',
  '...SSSSSSS..',
];
const SMALL = {
  st: [...SMALL_TOP, '..BBRBBB....', '.BBBRBBRBBB.', 'BBBBRRRRBBBB', 'SSBRSRRSRBSS', 'SSSRRRRRRSSS', 'SSRRRRRRRRSS', '..RRR..RRR..', '.BBB....BBB.', 'BBBB....BBBB'],
  ra: [...SMALL_TOP, '..BBBBRB....', '.BBBBRRBBS..', 'SBBBRRRRBSS.', 'SSSRSRRSRSS.', 'SSRRRRRRRR..', '..RRRRRRRRR.', '.RRRR...RRR.', 'BBBB.....BBB', '.BBBB....BB.'],
  rb: [...SMALL_TOP, '...BBRBB....', '..BBBRRBB...', '..BBRRSRR...', '..BBRRRRR...', '..SSRRRRR...', '..SSRRRRR...', '...RRRRR....', '...BBBBBB...', '...BBBB.....'],
  jp: ['...RRRRR..SS', '..RRRRRRRRSS', '..BBBSSBS.BB', '.BSBSSSBSSBB', '.BSBBSSSBSSB', '.BBSSSSBBBB.', '...SSSSSSSB.', '..BBRBBBRB..', '.BBBRBBBRB..', 'BBBBRRRRRB..', 'SSBRSRRSRR..', 'SSRRRRRRRR..', '..RRRRRRRRR.', '.RRRR..RRRR.', 'BBBB....BBB.', 'BBB.........'],
};
const BIG_TOP = [
  '.....RRRRR......',
  '....RRRRRRRRR...',
  '....RRRRRRRRRR..',
  '....BBBSSSBS....',
  '...BSBSSSSBSSS..',
  '...BSBBSSSSBSSS.',
  '...BBSSSSSBBBB..',
  '....BSSSSSSSS...',
  '.....SSSSSSS....',
  '....BBBRBBBB....',
  '...BBBBRBBRBB...',
  '..BBBBBRBBRBBB..',
  '.BBBBBBRRRRBBBB.',
  '.BBBBBRRRRRRBBB.',
  '.SSBBRRSRRSRRBSS',
  'SSSSRRRRRRRRRSSS',
  'SSSRRRRRRRRRRRSS',
  '.SSRRRRRRRRRRRS.',
  '...RRRRRRRRRRR..',
  '...RRRRRRRRRRR..',
  '...RRRRR.RRRRR..',
  '..RRRRR...RRRRR.',
];
const BIG_DUCK = [
  '.....RRRRR......', '....RRRRRRRRR...', '....BBBSSBS.....', '...BSBSSSBSSS...',
  '...BSBBSSSBSSS..', '...BBSSSSBBBB...', '.....SSSSSSS....', '...BBBRRBBRBB...',
  '..BBBBRRRRRBBB..', '.SSBRRSRRSRRBSS.', '.SSSRRRRRRRRSSS.', '.SSRRRRRRRRRRSS.',
  '..RRRRRRRRRRRR..', '..RRRRR..RRRRR..', '.BBBBB....BBBBB.', 'BBBBBB....BBBBBB',
];
const BIG_JUMP_TOP = ['.....RRRRR...SS.', '....RRRRRRRRRSS.', '....RRRRRRRRRRB.', ...BIG_TOP.slice(3)];
const BIG = {
  st: [...BIG_TOP, '..RRRR....RRRR..', '..RRRR....RRRR..', '..RRRR....RRRR..', '..RRR......RRR..', '..RRR......RRR..', '..RRR......RRR..', '.BBBB......BBBB.', 'BBBBB......BBBBB', 'BBBBB......BBBBB', 'BBBBB......BBBBB'],
  ra: [...BIG_TOP, '.RRRRR...RRRRR..', '.RRRR.....RRRR..', 'RRRR.......RRRR.', 'RRR.........RRR.', 'RRR.........RRR.', 'BBB..........RRR', 'BBBB.........BBB', 'BBB.........BBBB', 'BB..........BBBB', '............BBB.'],
  rb: [...BIG_TOP, '...RRRRRRRR.....', '....RRRRRR......', '....RRRRRR......', '....RRRRRR......', '.....RRRR.......', '.....RRRR.......', '.....RRRR.......', '....BBBBBB......', '...BBBBBBB......', '...BBBBBBB......'],
  jp: [...BIG_JUMP_TOP, '.RRRR.....RRRR..', 'RRRR.......RRRR.', 'RRR.........RRR.', 'RRR.........RRR.', 'BBB.........RRR.', 'BBBB........BBBB', 'BBB.........BBBB', '............BBB.', '................', '................'],
};
const MARIO_PAL = { R: '#d82800', B: '#6b3c00', S: '#fcb07c' };

const GOOMBA = [
  '......BBBB......', '.....BBBBBB.....', '....BBBBBBBB....', '...KKBBBBBBKK...',
  '..BBWKKBBKKWBB..', '.BBBWKWBBWKWBBB.', '.BBBWWWBBWWWBBB.', 'BBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBB', '.BBBBTTTTTTBBBB.', '......TTTT......', '.....TTTTTT.....',
  '...KKTTTTTTK....', '..KKKKTTTTKKKK..', '..KKKKK..KKKKK..', '...KKK....KKK...',
];
const GOOMBA_PAL = { B: '#a0420c', T: '#f8c890', K: '#000000', W: '#ffffff' };
const KOOPA = [
  '....SSS.........', '...SSSSS........', '..SSWKSS........', '..SSWKSS........',
  '..SSSSSS........', '.SSSSSSS........', '.SSS.SSS........', '......SS..GGGG..',
  '......SS.GGGGGG.', '.....SSSGGWGGWGG', '.....SSGGGGWWGGG', '.....SSGWGGWWGGW',
  '......SGGGWGGWGG', '......SGGGGGGGGG', '......SWWWWWWWWW', '.....SSSWWWWWWW.',
  '....SSSS...SSSS.', '....SSS.....SSS.',
];
const SHELL = [
  '.....GGGGGG.....', '...GGGWGGWGGG...', '..GGWGGWWGGWGG..', '.GGGGGWWWWGGGGG.',
  '.GGWGGWWWWGGWGG.', 'GGGGGGGWWGGGGGGG', 'GGGWGGGGGGGGWGGG', 'GGGGGGGGGGGGGGGG',
  'WWWWWWWWWWWWWWWW', 'KWWWWWWWWWWWWWWK', '.KWWWWWWWWWWWWK.', '..KKKKKKKKKKKK..',
];
const KOOPA_PAL = { G: '#00a800', W: '#fcfcfc', S: '#fcbc3c', K: '#000000' };

const Q_GLYPH = [
  '............', '............', '....GGGG....', '...GG..GG...', '.......GG...', '......GG....',
  '.....GG.....', '.....GG.....', '............', '.....GG.....', '............', '............',
];

function defs(th) {
  const brick = (fill, id) =>
    `<g id="${id}"><rect width="12" height="12" fill="${fill}"/>` +
    `<path fill="${th.hi}" d="M0 0h12v1H0zM0 6h12v1H0z"/>` +
    `<path fill="${th.mortar}" d="M0 5h12v1H0zM0 11h12v1H0zM5 0h1v5H5zM2 6h1v5H2zM9 6h1v5H9z"/></g>`;
  const rivets = (c) => `<path fill="${c}" d="M1 1h1v1H1zM10 1h1v1h-1zM1 10h1v1H1zM10 10h1v1h-1z"/>`;
  const spr = (id, rows, pal, ox, oy) => `<g id="${id}" transform="translate(${ox} ${oy}) scale(${SPR})">${pixelArt(rows, pal)}</g>`;
  return [
    `<rect id="e" width="12" height="12" rx="2" fill="${th.empty}"${th.emptyOp < 1 ? ` fill-opacity="${th.emptyOp}"` : ''}/>`,
    brick(th.brick[0], 'b1'),
    brick(th.brick[1], 'b2'),
    `<g id="q"><rect x=".5" y=".5" width="11" height="11" fill="${th.q}" stroke="${th.qDark}"/>` +
      `<path fill="#fcd8a8" d="M1 1h10v1H1zM1 2h1v9H1z"/>` + rivets(th.qDark) + pixelArt(Q_GLYPH, { G: th.qGlyph }) + `</g>`,
    `<g id="u"><rect x=".5" y=".5" width="11" height="11" fill="${th.used}" stroke="#000"/>${rivets('#000')}</g>`,
    `<rect id="k" width="5" height="5" fill="${th.brick[1]}" stroke="${th.mortar}" stroke-width=".8"/>`,
    `<g id="cn"><rect x="2.5" y=".5" width="7" height="11" rx="3" fill="${th.coin}" stroke="#7a4a00"/><rect x="5" y="3" width="2" height="6" fill="#fff4a0"/></g>`,
    `<g id="mu" stroke="#000" stroke-width=".7"><rect x="3" y="6.5" width="6" height="5" rx="1.5" fill="#fcd8a8"/>` +
      `<path d="M.6 7.4Q.6.4 6 .4t5.4 7z" fill="#d82800"/>` +
      `<g fill="#fff" stroke="none"><circle cx="3.3" cy="4.4" r="1.6"/><circle cx="8.7" cy="4.4" r="1.6"/><circle cx="6" cy="1.9" r="1.1"/></g>` +
      `<path stroke="none" fill="#000" d="M4.6 8h.9v2h-.9zM6.5 8h.9v2h-.9z"/></g>`,
    // Mario frames, origin = feet centre
    ...Object.entries(SMALL).map(([k, rows]) => spr('s' + k, rows, MARIO_PAL, -HW_SMALL, -H_SMALL)),
    ...Object.entries(BIG).map(([k, rows]) => spr('B' + k, rows, MARIO_PAL, -HW_BIG, -H_BIG)),
    spr('Bcr', BIG_DUCK, MARIO_PAL, -HW_BIG, -H_SMALL),
    // enemies, origin = feet centre
    spr('gm', GOOMBA, GOOMBA_PAL, -7.5, -GOOMBA_H),
    spr('kp', KOOPA, KOOPA_PAL, -7.5, -KOOPA_H),
    spr('sh', SHELL, KOOPA_PAL, -7.5, -SHELL_H),
    // lift (14x5), origin = top-left
    `<g id="lf"><rect x=".5" y=".5" width="13" height="4" fill="#fc9838" stroke="#7c2800"/><path fill="#7c2800" d="M3 2h1v1H3zM6.5 2h1v1h-1zM10 2h1v1h-1z"/></g>`,
    // warp pipe, origin = lip top-left, 26 wide
    `<g id="pp"><rect x="2" y="10" width="22" height="${PIPE_H - 10}" fill="#00a800" stroke="#000"/>` +
      `<path fill="#80d010" d="M5 10h3v${PIPE_H - 10}H5z"/><path fill="#005800" d="M18 10h2v${PIPE_H - 10}h-2zM21 10h2v${PIPE_H - 10}h-2z"/>` +
      `<rect x=".5" y=".5" width="25" height="9.5" fill="#00a800" stroke="#000"/>` +
      `<path fill="#80d010" d="M3 1h3v9H3z"/><path fill="#005800" d="M19 1h2v9h-2zM22 1h2v9h-2z"/></g>`,
    `<g id="cl" fill="${th.cloud}"${th.cloudOp < 1 ? ` opacity="${th.cloudOp}"` : ''}><circle cx="10" cy="8" r="6"/><circle cx="19" cy="5" r="7"/><circle cx="28" cy="8" r="6"/><rect x="6" y="8" width="26" height="6" rx="3"/></g>`,
    `<pattern id="gt" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="${th.ground}"/>` +
      `<path fill="${th.groundHi}" d="M0 0h16v1H0zM0 8h16v1H0zM0 1h1v7H0zM8 9h1v7H8z"/>` +
      `<path fill="${th.groundMortar}" d="M0 7h16v1H0zM0 15h16v1H0zM15 0h1v7h-1zM7 8h1v7H7z"/></pattern>`,
  ].join('');
}

// --------------------------------------------------------------- world ----

function buildWorld(cal) {
  const weeks = cal.weeks.map((w) => {
    const col = Array(7).fill(null);
    for (const d of w.contributionDays) col[d.weekday] = { count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0 };
    return col;
  });
  const W = weeks.length;
  const width = GX + W * PITCH + 50;
  const cells = [];
  const grid = weeks.map((col, c) =>
    col.map((d, r) => {
      if (!d) return null;
      const lv = d.level || (d.count > 0 ? 1 : 0);
      if (!lv) return { c, r, lv: 0 };
      const cell = { c, r, lv, i: cells.length, kind: lv <= 2 ? 'brick' : 'q', bumps: [], hit: null };
      cells.push(cell);
      return cell;
    }),
  );
  const activeCount = (c) => grid[c].filter((x) => x && x.lv).length;
  return { weeks, W, width, cells, grid, activeCount };
}

// Enemy / pit placement in fully empty weeks.
function placeEnemies(world) {
  const { W, activeCount } = world;
  const runs = [];
  for (let c = 0; c < W; ) {
    if (activeCount(c) === 0) {
      let b = c;
      while (b + 1 < W && activeCount(b + 1) === 0) b++;
      runs.push({ a: c, b, n: b - c + 1 });
      c = b + 1;
    } else c++;
  }
  const koopas = [];
  const stompers = [];
  const free = [];
  for (const run of [...runs].sort((x, y) => y.n - x.n)) {
    if (koopas.length < 2 && run.n >= 11) {
      const k = run.a + 3;
      const victims = [];
      for (let v = k + 3; v + 2 <= run.b - 2 && victims.length < 4; v += 2) victims.push(v);
      const pit = victims.at(-1) + 2;
      koopas.push({ c: k, victims, pit });
      // leftover tail of a long run can still host a stomp goomba
      if (run.b - (pit + 2) >= 6) free.push({ a: pit + 2, b: run.b, n: run.b - pit - 1 });
    } else free.push(run);
  }
  for (const run of free.sort((x, y) => x.a - y.a)) {
    if (stompers.length >= 3) break;
    if (run.n >= 7) stompers.push({ c: run.a + 3 });
  }
  return { koopas, stompers };
}

// ------------------------------------------------------------ planner ----

function plan(world, enemies, k) {
  const { W, width, grid } = world;
  const g = GRAV / (k * k);
  const vRun = V_RUN / k;
  const vLift = V_LIFT / k;
  const vShell = V_SHELL / k;
  const LPX = 15;
  const RPX = width - 19;
  const IB = { x: GX - 15, y: GY + 5 * PITCH }; // intro ? block (outside the grid)

  let t = 0, x = LPX, y = 0, big = false;
  const X = [{ t: 0, x }];
  const Y = [{ t: 0, y: 0, e: 'l' }];
  const poses = [{ t: 0, p: 'st' }];
  const lifts = new Map(); // col -> [{t,y}]
  const pops = []; // {x,y,t,txt}
  const stats = { direct: 0, chain: 0, gap: 0, lift: 0, side: 0 };
  const state = grid.map((col) => col.map((d) => (d && d.lv ? 'solid' : 'empty')));
  const ev = { intro: {}, stomps: [], koopas: [] };

  const H = () => (big ? H_BIG : H_SMALL);
  const pose = (p) => { if (poses.at(-1).p !== p) poses.push({ t, p }); };
  const xk = (xx) => { const l = X.at(-1); if (l.t === t && l.x === xx) return; X.push({ t, x: xx }); x = xx; };
  const yk = (yy, e = 'l') => { Y.push({ t, y: yy, e }); y = yy; };
  const wait = (dt, p = 'st') => { pose(p); t += dt; };
  const runTo = (x1, p = 'rn') => {
    if (Math.abs(x1 - x) < 0.01) return;
    xk(x);
    pose(p);
    t += Math.abs(x1 - x) / vRun;
    xk(x1);
  };
  // Ballistic hop: rise hUp from current y, then fall to yEnd. xPts: [[dt, x], ...] relative to takeoff.
  // airPose 'cr' is SMB1's duck-jump (big Mario keeps the one-block-tall ducking hitbox).
  const hop = (hUp, yEnd, xPts = [], airPose = 'jp', endPose = 'st') => {
    const t0 = t, y0 = y;
    const tu = Math.sqrt((2 * hUp) / g);
    const yPeak = y0 - hUp;
    const td = Math.sqrt((2 * (yEnd - yPeak)) / g);
    xk(x);
    pose(airPose);
    Y.push({ t: t0, y: y0, e: 'u' });
    Y.push({ t: t0 + tu, y: yPeak, e: 'd' });
    Y.push({ t: t0 + tu + td, y: yEnd, e: 'l' });
    for (const [dt, xx] of xPts) X.push({ t: t0 + dt, x: xx });
    if (xPts.length) x = xPts.at(-1)[1];
    t = t0 + tu + td;
    y = yEnd;
    pose(endPose);
    return { t0, tPeak: t0 + tu, tu, td };
  };
  const liftTo = (c, y1, p = 'st') => {
    const L = lifts.get(c) ?? [];
    lifts.set(c, L);
    pose(p);
    L.push({ t, y });
    Y.push({ t, y, e: 'l' });
    t += Math.abs(y1 - y) / vLift;
    L.push({ t, y: y1 });
    yk(y1);
  };

  // ---- intro: rise out of the pipe, hop down, bump the intro block, grow
  t = 0.3 * k; yk(0);
  t += 0.7 * k; yk(-PIPE_H);
  wait(0.2 * k);
  const landX = colCx(-1);
  {
    // rise 12 (head stays under the intro block), clear the pipe lip before dropping below its top
    const tu = Math.sqrt(24 / g), td = Math.sqrt((2 * (PIPE_H + 12)) / g);
    hop(12, 0, [[0, LPX], [tu, LPX + 12], [tu + td, landX]]);
  }
  wait(0.05 * k);
  const ibJ = GROUND - H_SMALL - (IB.y + CELL);
  const ibHit = hop(ibJ, 0).tPeak;
  const mush = { t0: ibHit + 0.05 * k };
  mush.t1 = mush.t0 + 0.5 * k; // fully out
  mush.t2 = mush.t1 + 0.25 * k; // slid right
  const fallH = GROUND - (IB.y - CELL) - CELL;
  mush.t3 = mush.t2 + Math.sqrt((2 * fallH) / g); // landed
  mush.dx = 14;
  mush.fall = fallH;
  if (t < mush.t3) wait(mush.t3 - t);
  const touchX = IB.x + 6 + mush.dx - (HW_SMALL + 6);
  runTo(Math.max(x, touchX));
  mush.tGrab = t;
  ev.intro = { hit: ibHit, mush, IB };
  pops.push({ x: x, y: GROUND - H_SMALL - 6, t, txt: '1000' });
  const growT0 = t;
  wait(0.8 * k);
  big = true;
  const growT1 = t;

  // ---- stations
  const stations = [];
  for (let c = 0; c < W; c++) if (world.activeCount(c)) stations.push({ type: 'col', c });
  for (const s of enemies.stompers) stations.push({ type: 'goomba', c: s.c, ref: s });
  for (const kp of enemies.koopas) {
    stations.push({ type: 'koopa', c: kp.c, ref: kp });
    stations.push({ type: 'pit', c: kp.pit, ref: kp });
  }
  stations.sort((a, b) => a.c - b.c);

  // Next target for a Mario standing below row `below` in a column.
  //  direct: the lowest solid block is un-hit -> hit it.
  //  chain:  the lowest solid block is a used block -> bump it; the bump pops the
  //          top-most un-hit block of the stack touching it.
  //  gap:    that touching stack is all used blocks; un-hit blocks sit above empty space.
  const pickTarget = (S, below) => {
    let b = -1;
    for (let rr = below - 1; rr >= 0; rr--) if (S[rr] !== 'empty') { b = rr; break; }
    if (b < 0) return null;
    if (S[b] === 'solid') return { r: b, b, kind: 'direct' };
    let top = b;
    while (top > 0 && S[top - 1] !== 'empty') top--;
    for (let rr = top; rr < b; rr++) if (S[rr] === 'solid') return { r: rr, b, kind: 'chain' };
    for (let rr = top - 1; rr >= 0; rr--) if (S[rr] === 'solid') return { b, top, kind: 'gap' };
    return null;
  };
  const register = (c, pk, tPeak) => {
    const S = state[c];
    const r = pk.r;
    const cell = grid[c][r];
    cell.hit = tPeak;
    cell.contact = pk.b;
    cell.roomAbove = r === 0 || S[r - 1] === 'empty';
    for (let rr = r + 1; rr <= pk.b; rr++) if (S[rr] !== 'empty') grid[c][rr].bumps.push(tPeak);
    stats[pk.kind]++;
    if (pk.kind === 'gap') (stats.gapCells ??= []).push(`week ${c} row ${r}`);
    if (cell.kind === 'q') { cell.bumps.push(tPeak); S[r] = 'used'; }
    else S[r] = 'empty';
  };

  // Un-hit blocks floating above a used block: ride a lift up the neighbouring
  // column to the used block's top, step across, and hit them from there
  // (duck-jumping in a one-block gap, as big Mario can in SMB1).
  const sideEntry = (c, top0) => {
    const S = state[c];
    let top = top0;
    let above = pickTarget(S, top);
    while (above && above.kind === 'gap') { top = above.top; above = pickTarget(S, top); }
    if (!above) return false;
    const surf = cellTop(top);
    const room = surf - cellBottom(above.b);
    const Hs = room >= H_BIG + 3 ? H_BIG : H_SMALL;
    if (room < Hs + 2 || room - Hs > JMAX) return false;
    let n = -1;
    for (const cand of [c - 1, c + 1]) {
      if (cand < 0 || cand >= W) continue;
      let ok = true;
      for (let rr = 0; rr < 7; rr++) if (cellBottom(rr) > surf - Hs && state[cand][rr] !== 'empty') ok = false;
      if (ok) { n = cand; break; }
    }
    if (n < 0) return false;
    const duck = Hs === H_SMALL;
    const pAir = duck ? 'cr' : 'jp', pStand = duck ? 'cr' : 'st', pMove = duck ? 'cr' : 'rn';
    if (Math.abs(y) > 0.01) liftTo(c, 0);
    runTo(colCx(n));
    liftTo(n, surf - GROUND, pStand);
    runTo(colCx(c), pMove);
    for (;;) {
      const pk = pickTarget(S, top);
      if (!pk || pk.kind === 'gap') break;
      const J = surf - Hs - cellBottom(pk.b);
      if (J < 2 || J > JMAX) break;
      const { tPeak } = hop(J, y, [], pAir, pStand);
      register(c, pk, tPeak);
      stats.side++;
      wait(0.05 * k, pStand);
    }
    runTo(colCx(n), pMove);
    liftTo(n, 0, pStand);
    pose('st');
    return true;
  };

  const doColumn = (c) => {
    const cx = colCx(c);
    const S = state[c];
    let first = true;
    for (;;) {
      if (!S.includes('solid')) break;
      const pk = pickTarget(S, 7);
      if (pk.kind === 'gap') {
        if (sideEntry(c, pk.top)) { first = true; continue; }
        // fallback: bump the used stack and pop the lowest block across the gap
        for (let rr = pk.b - 1; rr >= 0; rr--) if (S[rr] === 'solid') { pk.r = rr; break; }
      }
      const b = pk.b;
      const cb = cellBottom(b);
      const h = H();
      const needLift = GROUND - h - cb > JMAX;
      const ys = needLift ? cb + h + J_LIFT - GROUND : 0;
      let xPts = [];
      if (first) {
        first = false;
        if (!needLift && y === 0) {
          const J = GROUND - h - cb;
          const tu = Math.sqrt((2 * J) / g);
          const sc = GROUND - h - GRID_BOTTOM; // head clears the grid bottom after rising sc
          const tc = sc >= J ? tu : tu * (1 - Math.sqrt(1 - sc / J));
          const D = Math.min(vRun * tc, Math.max(0, cx - x));
          runTo(cx - D);
          if (D > 0.01) xPts = [[0, cx - D], [D / vRun, cx]];
        } else runTo(cx);
      }
      if (Math.abs(ys - y) > 0.01) liftTo(c, ys);
      if (needLift) stats.lift++;
      const J = GROUND + y - h - cb;
      const { tPeak } = hop(J, y, xPts);
      register(c, pk, tPeak);
      wait(0.05 * k);
    }
    if (Math.abs(y) > 0.01) liftTo(c, 0);
  };

  const stomp = (xm, hE) => {
    const hUp = hE + 12;
    const tu = Math.sqrt((2 * hUp) / g), td = Math.sqrt((2 * 12) / g);
    const D = vRun * (tu + td);
    runTo(xm - D);
    hop(hUp, -hE, [[0, xm - D], [tu + td, xm]]);
    return t; // contact time
  };

  for (const st of stations) {
    if (st.type === 'col') doColumn(st.c);
    else if (st.type === 'goomba') {
      const xm = colCx(st.c);
      const tm = stomp(xm, GOOMBA_H);
      const tu = Math.sqrt((2 * 20) / g), td = Math.sqrt((2 * (GOOMBA_H + 20)) / g);
      hop(20, 0, [[0, xm], [tu + td, xm + vRun * (tu + td)]]);
      ev.stomps.push({ xm, tm });
      pops.push({ x: xm, y: GROUND - 26, t: tm, txt: '100' });
    } else if (st.type === 'koopa') {
      const xm = colCx(st.c);
      const tm = stomp(xm, KOOPA_H);
      const tu = Math.sqrt((2 * 18) / g), td = Math.sqrt((2 * (KOOPA_H + 18)) / g);
      hop(18, 0, [[0, xm], [tu + td, xm - 20]]);
      wait(0.12 * k);
      runTo(xm - HW_BIG - 7.5);
      const tKick = t;
      pops.push({ x: xm, y: GROUND - 28, t: tm, txt: '100' });
      const kp = st.ref;
      const pitX = colCx(kp.pit);
      const victims = kp.victims.map((v, i) => {
        const vx = colCx(v);
        const th = tKick + (vx - 15 - xm) / vShell;
        pops.push({ x: vx, y: GROUND - 26, t: th, txt: String(100 * 2 ** i) });
        return { vx, th };
      });
      const tFall = tKick + (pitX - xm) / vShell;
      ev.koopas.push({ xm, tm, tKick, victims, pitX, tFall, vShell });
      wait(0.08 * k);
    } else if (st.type === 'pit') {
      const px = colCx(st.c);
      const half = 18;
      runTo(px - half);
      const tAir = (2 * half) / vRun;
      const hUp = Math.max(10, (g * (tAir / 2) ** 2) / 2);
      hop(hUp, 0, [[0, px - half], [tAir, px + half]]);
    }
  }

  // ---- outro: hop onto the right pipe (clearing the lip), sink in
  runTo(RPX - 22.5);
  {
    const tu = Math.sqrt((2 * 48) / g), td = Math.sqrt((2 * 18) / g);
    hop(48, -PIPE_H, [[0, RPX - 22.5], [tu, RPX - 18], [tu + td, RPX]]);
  }
  wait(0.35 * k);
  Y.push({ t, y: -PIPE_H, e: 'l' });
  t += 0.9 * k;
  yk(0);
  const tEnd = t;
  const T = Math.round(((tEnd + HOLD_END) / RESTORE) * 10 + 0.5) / 10;
  Y.push({ t: T, y: 0, e: 'l' });
  X.push({ t: T, x: RPX });

  return { T, X, Y, poses, lifts, pops, stats, ev, growT0, growT1, LPX, RPX, IB, k };
}

// --------------------------------------------------------------- render ----

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const r2 = (n) => +n.toFixed(2);
const EASE = { u: 'cubic-bezier(.33,.67,.67,1)', d: 'cubic-bezier(.33,0,.67,.33)' };

function render(cal, user, themeName, P, world, enemies) {
  const th = THEMES[themeName];
  const { W, width, cells } = world;
  const { T } = P;
  const TR = T * RESTORE;
  const pc = (t) => +Math.min(100, Math.max(0, (t / T) * 100)).toFixed(3);
  // Keyframes: frames at the same percentage are merged, then percentages sharing
  // an identical body are grouped ("1%,7%{opacity:0}") to keep the file small.
  const kf = (name, frames) => {
    const m = new Map();
    for (const [t, css] of frames) {
      const p = pc(t);
      m.set(p, m.has(p) ? m.get(p) + ';' + css : css);
    }
    const byCss = new Map();
    for (const [p, css] of [...m].sort((a, b) => a[0] - b[0])) {
      if (!byCss.has(css)) byCss.set(css, []);
      byCss.get(css).push(p + '%');
    }
    return `@keyframes ${name}{${[...byCss].map(([css, ps]) => `${ps.join(',')}{${css}}`).join('')}}`;
  };
  const tr = (x, y) => (x || y ? `transform:translate(${r2(x)}px,${r2(y)}px)` : 'transform:none');
  const an = (name) => `style="animation-name:${name}"`;
  const dl = (t) => `style="--d:${r2(t)}s"`;
  const css = [];
  const k = P.k;

  // .a = timeline animation (duration T). Per-element keyframes carry their own times.
  // .e = one-shot effect (debris, coin, bump, score): shared keyframes that start at
  //      local 0 and are invisible/neutral otherwise, offset by --d (set on the element
  //      or inherited from its group). Effects never need restoring, so a delay is safe.
  css.push(`.a{animation-duration:${T}s;animation-iteration-count:infinite;animation-timing-function:linear;animation-fill-mode:backwards;animation-delay:0s}.e{animation-delay:var(--d)}`);
  css.push(`.s{animation-timing-function:step-end}.o{opacity:0}`);
  css.push(`.fa,.fb{animation:fr .2s step-end infinite}.fb{animation-delay:-.1s}@keyframes fr{0%{opacity:1}50%{opacity:0}}`);
  css.push(`.sp{animation:sp .45s linear infinite;transform-box:fill-box;transform-origin:center}@keyframes sp{50%{transform:scaleX(.15)}}`);
  css.push(`.fx{transform-box:fill-box;transform-origin:50% 100%}.fc{transform-box:fill-box;transform-origin:center}`);
  css.push(`.gw{animation:gw .5s step-end infinite;transform-box:fill-box;transform-origin:center}@keyframes gw{50%{transform:scaleX(-1)}}`);
  css.push(`.kw{animation:kw .5s step-end infinite}@keyframes kw{50%{transform:translateY(-1px)}}`);
  css.push(`.cl{animation:cl 90s linear infinite}@keyframes cl{from{transform:translateX(${width + 10}px)}to{transform:translateX(-50px)}}`);
  css.push(`.hud{font:bold 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${th.hud};letter-spacing:.5px}`);
  css.push(`.sc{font:bold 7px ui-monospace,Menlo,Consolas,monospace;fill:#fff;stroke:#000;stroke-width:.4px;paint-order:stroke}`);
  // shared one-shot effects
  const EO = 'animation-timing-function:ease-out', EI = 'animation-timing-function:ease-in';
  css.push(`.bu{animation-name:bu}.dh{animation-name:dh}.dl{animation-name:dl}.cn{animation-name:cn}.mu{animation-name:mu}.pp{animation-name:pp}`);
  css.push(kf('bu', [[0, `transform:none;${EO}`], [0.07 * k, `transform:translateY(-4px);${EI}`], [0.14 * k, 'transform:none'], [T, 'transform:none']]));
  for (const [n, dx1, dy1, dx2, dy2] of [['dh', -7, -13, -18, 70], ['dl', -5, -5, -12, 70]]) {
    css.push(kf(n, [[0, 'opacity:0;transform:none'], [0.01, `opacity:1;transform:none;${EO}`], [0.2, `${tr(dx1, dy1)};${EI}`], [0.75, `opacity:1;${tr(dx2, dy2)}`], [0.77, `opacity:0;${tr(dx2, dy2)}`], [T, `opacity:0;${tr(dx2, dy2)}`]]));
  }
  css.push(kf('cn', [[0, 'opacity:0;transform:none'], [0.01, `opacity:1;${tr(0, -4)};${EO}`], [0.3, `opacity:1;${tr(0, -20)};${EI}`], [0.5, `opacity:0;${tr(0, -10)}`], [T, `opacity:0;${tr(0, -10)}`]]));
  css.push(kf('mu', [[0, 'opacity:0;transform:none'], [0.01, `opacity:1;${tr(0, -1)}`], [0.45, `opacity:1;${tr(0, -12)}`], [0.8, `opacity:1;${tr(0, -12)}`], [1, `opacity:0;${tr(0, -14)}`], [T, `opacity:0;${tr(0, -14)}`]]));
  css.push(kf('pp', [[0, 'opacity:0;transform:none'], [0.01, 'opacity:1;transform:none'], [0.6, `opacity:1;${tr(0, -12)}`], [0.8, `opacity:0;${tr(0, -14)}`], [T, `opacity:0;${tr(0, -14)}`]]));
  const bumpWrap = (bumps, inner) => bumps.reduce((acc, b) => `<g class="a e bu" ${dl(b)}>${acc}</g>`, inner);

  // ---- blocks
  const gridSvg = [];
  const debris = [];
  const items = [];
  for (let c = 0; c < W; c++) {
    for (let r = 0; r < 7; r++) {
      const d = world.grid[c][r];
      if (!d) continue;
      const x = colX(c), y = cellTop(r);
      if (!d.lv) { gridSvg.push(`<use href="#e" x="${x}" y="${y}"/>`); continue; }
      const i = d.i, h = d.hit;
      if (d.kind === 'brick') {
        gridSvg.push(`<g transform="translate(${x} ${y})"><use href="#e"/>${bumpWrap(d.bumps, `<use href="#b${d.lv}" class="a" ${an('b' + i)}/>`)}</g>`);
        css.push(kf('b' + i, [[0, 'opacity:1'], [h, 'opacity:1'], [h + 0.02, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
        const ch = (n) => `<use href="#k" class="a e o ${n}"/>`;
        debris.push(`<g transform="translate(${x} ${y})" ${dl(h)}>${ch('dh')}<g transform="translate(0 6)">${ch('dl')}</g>` +
          `<g transform="matrix(-1 0 0 1 12 0)">${ch('dh')}<g transform="translate(0 6)">${ch('dl')}</g></g></g>`);
      } else {
        gridSvg.push(`<g transform="translate(${x} ${y})">${bumpWrap(d.bumps, `<use href="#u"/><use href="#q" class="a" ${an('q' + i)}/>`)}</g>`);
        css.push(kf('q' + i, [[0, 'opacity:1'], [h + 0.08 * k, 'opacity:1'], [h + 0.09 * k, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
        if (d.lv === 3) {
          items.push(`<g transform="translate(${x} ${y})"><g class="a e o cn" ${dl(h)}><use href="#cn" class="sp"/></g></g>`);
        } else if (!d.roomAbove) {
          // a block sits right on top, so the mushroom can't come out: just score it
          P.pops.push({ x: x + 6, y: y - 2, t: h + 0.1, txt: '1000' });
        } else {
          items.push(`<g transform="translate(${x} ${y})"><use href="#mu" class="a e o mu" ${dl(h)}/></g>`);
          P.pops.push({ x: x + 6, y: y - 14, t: h + 0.45, txt: '1000' });
        }
      }
    }
  }

  // ---- intro ? block + its mushroom
  const { IB, mush, hit: ibHit } = P.ev.intro;
  const introSvg =
    `<g transform="translate(${IB.x} ${IB.y})"><use href="#mu" class="a o" ${an('im')}/></g>` +
    `<g transform="translate(${IB.x} ${IB.y})"><g class="a" ${an('ip')}><use href="#u"/><use href="#q" class="a" ${an('iq')}/></g></g>`;
  css.push(kf('ip', [[0, 'transform:none'], [ibHit, 'transform:none;animation-timing-function:ease-out'], [ibHit + 0.07 * k, 'transform:translateY(-4px);animation-timing-function:ease-in'], [ibHit + 0.14 * k, 'transform:none'], [T, 'transform:none']]));
  css.push(kf('iq', [[0, 'opacity:1'], [ibHit + 0.08 * k, 'opacity:1'], [ibHit + 0.09 * k, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
  css.push(kf('im', [
    [0, `opacity:0;${tr(0, 0)}`], [mush.t0, `opacity:1;${tr(0, 0)}`], [mush.t1, `opacity:1;${tr(0, -CELL)}`],
    [mush.t2, `opacity:1;${tr(mush.dx, -CELL)};animation-timing-function:${EASE.d}`],
    [mush.t3, `opacity:1;${tr(mush.dx, -CELL + mush.fall)}`], [mush.tGrab, `opacity:1;${tr(mush.dx, -CELL + mush.fall)}`],
    [mush.tGrab + 0.01, `opacity:0;${tr(mush.dx, -CELL + mush.fall)}`], [T, `opacity:0;${tr(0, 0)}`],
  ]));

  // ---- lifts
  const liftSvg = [];
  for (const [c, L] of P.lifts) {
    liftSvg.push(`<rect x="${colX(c) - 1}" y="${GROUND}" width="14" height="5" fill="#000" fill-opacity=".45"/>`);
    liftSvg.push(`<g transform="translate(${colX(c) - 1} ${GROUND})"><use href="#lf" class="a" ${an('L' + c)}/></g>`);
    css.push(kf('L' + c, [[0, 'transform:none'], ...L.map(({ t, y }) => [t, y ? `transform:translateY(${r2(y)}px)` : 'transform:none']), [T, 'transform:none']]));
  }

  // ---- enemies
  const enemySvg = [];
  P.ev.stomps.forEach(({ xm, tm }, j) => {
    const walk = 24, ta = tm - 2 * k;
    enemySvg.push(`<g transform="translate(${xm} ${GROUND})"><g class="a" ${an('E' + j)}><g class="a fx" ${an('Q' + j)}><use href="#gm" class="gw"/></g></g></g>`);
    css.push(kf('E' + j, [
      [0, `opacity:1;${tr(walk, 0)}`], [ta, `opacity:1;${tr(walk, 0)}`], [tm, tr(0, 0)],
      [tm + 0.7, 'opacity:1'], [tm + 0.9, 'opacity:0'], [TR - 0.01, `opacity:0;${tr(0, 0)}`], [TR, `opacity:0;${tr(walk, 0)}`], [T, `opacity:1;${tr(walk, 0)}`],
    ]));
    css.push(kf('Q' + j, [[0, 'transform:none'], [tm, 'transform:none'], [tm + 0.03, 'transform:scaleY(.35)'], [TR - 0.01, 'transform:scaleY(.35)'], [TR, 'transform:none'], [T, 'transform:none']]));
  });
  P.ev.koopas.forEach(({ xm, tm, tKick, victims, pitX, tFall, vShell }, j) => {
    const walk = 24, ta = tm - 2 * k;
    const xf = pitX - xm;
    const fallDur = 0.3 * k;
    enemySvg.push(
      `<g transform="translate(${xm} ${GROUND})"><g class="a" ${an('K' + j)}>` +
        `<g class="a" ${an('KK' + j)}><use href="#kp" class="kw"/></g><g class="a o" ${an('KS' + j)}><use href="#sh"/></g></g></g>`,
    );
    css.push(kf('K' + j, [
      [0, tr(walk, 0)], [ta, tr(walk, 0)], [tm, tr(0, 0)], [tKick, tr(0, 0)], [tFall, `${tr(xf, 0)};animation-timing-function:ease-in`],
      [tFall + fallDur, tr(xf + vShell * fallDur * 0.6, 40)], [TR, tr(walk, 0)], [T, tr(walk, 0)],
    ]));
    css.push(kf('KK' + j, [[0, 'opacity:1'], [tm, 'opacity:1'], [tm + 0.01, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
    css.push(kf('KS' + j, [[0, 'opacity:0'], [tm, 'opacity:0'], [tm + 0.01, 'opacity:1'], [tFall + fallDur, 'opacity:1'], [tFall + fallDur + 0.01, 'opacity:0'], [T, 'opacity:0']]));
    victims.forEach(({ vx, th }, n) => {
      const id = `V${j}_${n}`;
      enemySvg.push(`<g transform="translate(${vx} ${GROUND})"><g class="a fc" ${an(id)}><use href="#gm" class="gw"/></g></g>`);
      const f = (x, y, s) => `transform:translate(${x}px,${y}px) scaleY(${s})`;
      css.push(kf(id, [
        [0, `opacity:1;${f(0, 0, 1)}`], [th, `opacity:1;${f(0, 0, 1)}`],
        [th + 0.02, `${f(2, -4, -1)};animation-timing-function:ease-out`],
        [th + 0.17, `${f(6, -14, -1)};animation-timing-function:ease-in`],
        [th + 0.75, `opacity:1;${f(14, 70, -1)}`], [th + 0.76, 'opacity:0'],
        [TR - 0.01, `opacity:0;${f(14, 70, -1)}`], [TR, `opacity:0;${f(0, 0, 1)}`], [T, `opacity:1;${f(0, 0, 1)}`],
      ]));
    });
  });

  // ---- score popups
  const popSvg = P.pops.map(({ x, y, t, txt }) =>
    `<text class="a e o pp sc" ${dl(t)} x="${r2(x)}" y="${r2(y)}" text-anchor="middle">${txt}</text>`).join('');

  // ---- Mario
  css.push(kf('mx', P.X.map(({ t, x }) => [t, `transform:translateX(${r2(x)}px)`])));
  css.push(kf('my', P.Y.map(({ t, y, e }) => [t, `transform:translateY(${r2(y)}px)${e !== 'l' ? ';animation-timing-function:' + EASE[e] : ''}`])));
  for (const p of ['st', 'rn', 'jp', 'cr']) {
    const frames = P.poses.map(({ t, p: q }) => [t, `opacity:${q === p ? 1 : 0}`]);
    frames.push([T, `opacity:${P.poses.at(-1).p === p ? 1 : 0}`]);
    css.push(kf('z' + p, frames));
  }
  // size: small until growT0, flicker, big from growT1
  {
    const sF = [[0, 'opacity:1']], bF = [[0, 'opacity:0']];
    const n = 8, dt = (P.growT1 - P.growT0) / n;
    for (let i = 0; i < n; i++) {
      const bigOn = i % 2 === 0;
      sF.push([P.growT0 + i * dt, `opacity:${bigOn ? 0 : 1}`]);
      bF.push([P.growT0 + i * dt, `opacity:${bigOn ? 1 : 0}`]);
    }
    sF.push([P.growT1, 'opacity:0'], [T, 'opacity:0']);
    bF.push([P.growT1, 'opacity:1'], [T, 'opacity:1']);
    css.push(kf('zS', sF), kf('zB', bF));
  }
  const poseSet = (pre) =>
    `<g class="a s" ${an('zst')}><use href="#${pre}st"/></g>` +
    `<g class="a s o" ${an('zrn')}><use href="#${pre}ra" class="fa"/><use href="#${pre}rb" class="fb"/></g>` +
    `<g class="a s o" ${an('zjp')}><use href="#${pre}jp"/></g>` +
    `<g class="a s o" ${an('zcr')}><use href="#${pre === 'B' ? 'Bcr' : 'sst'}"/></g>`;
  const mario = `<g transform="translate(0 ${GROUND})"><g class="a" ${an('mx')}><g class="a" ${an('my')}>` +
    `<g class="a s" ${an('zS')}>${poseSet('s')}</g><g class="a s o" ${an('zB')}>${poseSet('B')}</g></g></g></g>`;

  // ---- scenery
  const clouds = [[GRID_BOTTOM + 6, 0], [GRID_BOTTOM + 14, -30], [GY + 30, -55], [GRID_BOTTOM + 2, -75]]
    .map(([y, d]) => `<g transform="translate(0 ${y})"><use href="#cl" class="cl" style="animation-delay:${d}s"/></g>`).join('');
  const pipeTop = GROUND - PIPE_H;
  const pipes = `<use href="#pp" x="${P.LPX - 13}" y="${pipeTop}"/><use href="#pp" x="${P.RPX - 13}" y="${pipeTop}"/>`;
  // ground with pits
  const pits = enemies.koopas.map((kp) => [colCx(kp.pit) - 10, colCx(kp.pit) + 10]).sort((a, b) => a[0] - b[0]);
  let gx0 = 0;
  const groundSvg = [];
  for (const [a, b] of [...pits, [width, width]]) {
    if (a > gx0) groundSvg.push(`<rect x="${gx0}" y="${GROUND}" width="${a - gx0}" height="${GROUND_H}" fill="url(#gt)"/>`);
    gx0 = b;
  }

  const lastDay = cal.weeks.at(-1)?.contributionDays.at(-1)?.date ?? new Date().toISOString();
  const hud = `<g class="hud"><text x="8" y="12">${esc(user.toUpperCase())}</text>` +
    `<text x="${r2(width / 2)}" y="12" text-anchor="middle">COINS ×${cal.totalContributions}</text>` +
    `<text x="${width - 8}" y="12" text-anchor="end">WORLD ${lastDay.slice(0, 4)}</text></g>`;

  const title = `${user}: ${cal.totalContributions} contributions in the last year, as a Super Mario Bros level`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><defs>${defs(th)}</defs><style>${css.join('')}</style>` +
    `<rect width="${width}" height="${HEIGHT}" fill="${th.bg}"/>${clouds}` +
    `<g shape-rendering="crispEdges">${gridSvg.join('')}</g>${introSvg}${liftSvg.join('')}${enemySvg.join('')}${mario}` +
    `<g shape-rendering="crispEdges">${debris.join('')}</g>${items.join('')}${pipes}${groundSvg.join('')}${popSvg}${hud}</svg>\n`;
}

// --------------------------------------------------------------- driver ----

function generate(cal, user) {
  // Plan at natural speed; if the loop is too long, speed everything up uniformly.
  const plan1 = () => {
    const world = buildWorld(cal);
    const enemies = placeEnemies(world);
    return { world, enemies };
  };
  let { world, enemies } = plan1();
  let P = plan(world, enemies, 1);
  if (P.T > TARGET_T) {
    let k = TARGET_T / P.T;
    for (let i = 0; i < 6; i++) {
      ({ world, enemies } = plan1());
      P = plan(world, enemies, k);
      if (P.T <= MAX_T) break;
      k *= MAX_T / P.T * 0.98;
    }
  }
  return { P, world, enemies };
}

async function main() {
  const { values } = parseArgs({
    options: { user: { type: 'string' }, out: { type: 'string', default: 'dist' }, data: { type: 'string' } },
  });
  if (!values.user) {
    console.error('usage: node mario-graph.mjs --user <login> [--out dist] [--data contrib.json]');
    process.exit(2);
  }
  const json = values.data ? JSON.parse(await readFile(values.data, 'utf8')) : await fetchCalendar(values.user);
  const cal = extractCalendar(json);
  const { P, world, enemies } = generate(cal, values.user);
  await mkdir(values.out, { recursive: true });
  for (const [theme, file] of [['light', 'mario-contribution-graph.svg'], ['dark', 'mario-contribution-graph-dark.svg']]) {
    // render mutates pops (adds mushroom 1000s); render each from a fresh copy
    const svg = render(cal, values.user, theme, { ...P, pops: [...P.pops] }, world, enemies);
    const path = join(values.out, file);
    await writeFile(path, svg);
    console.log(`wrote ${path} (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`);
  }
  const s = P.stats;
  console.log(`loop ${P.T}s (speed x${(1 / P.k).toFixed(2)}), ${world.cells.length} blocks: ${s.direct} direct, ${s.chain} via used block, ${s.gap} across a gap; ${s.lift} lift jumps on ${P.lifts.size} lifts; ` +
    `${enemies.stompers.length} goombas, ${enemies.koopas.length} koopas (${enemies.koopas.reduce((a, kp) => a + kp.victims.length, 0)} shell victims)` + (s.gapCells ? `; gap hits: ${s.gapCells.join(", ")}` : "") + `; ${s.side} hit from a side lift`);
}

// Exported for tests / plan validation; the CLI only runs when executed directly.
export { extractCalendar, generate, render };
export const LAYOUT = { CELL, PITCH, GX, GY, GRID_BOTTOM, GROUND, PIPE_H, H_SMALL, H_BIG, HW_SMALL, HW_BIG, JMAX, GOOMBA_H, KOOPA_H, RESTORE };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? err);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Super Mario Bros-styled GitHub contribution graph generator (v3, level variants).
// Zero dependencies, Node 22+, ESM. Output is a self-contained animated SVG
// (pure CSS @keyframes, no JS, no external fonts/images) suitable for <img>.
//
//   node .github/mario/mario-graph.mjs --user <login> --out dist [--data contrib.json]
//                              [--variant <name>|auto] [--all] [--list]
//
//   --variant <name>  render that level variant into mario-contribution-graph(-dark).svg
//   --variant auto    (default) rotate: floor(Date.now() / 12h) % number of variants
//   --all             also write every variant as mario-<name>.svg / mario-<name>-dark.svg
//   --list            print the variants and the current auto pick
//
// Without --data, the calendar is fetched from the GitHub GraphQL API using
// the GITHUB_TOKEN environment variable.
//
// How the level plays (all variants):
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
//  * Enemies live only in fully empty weeks; what they do depends on the
//    variant (see VARIANTS). Endings: right warp pipe, or flagpole + castle.
//  * Everything is restored during the last 3% of the loop.

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
// carrying pose: hands moved to the front (right) at chest height
const holdify = (rows) => rows.map((row, i) => (i >= 14 && i <= 17 ? row.replace(/^.?S+/, (m) => '.'.repeat(m.length)).slice(0, 14) + 'SS' : row));
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
    spr('Bho', holdify(BIG.st), MARIO_PAL, -HW_BIG, -H_BIG),
    spr('Bha', holdify(BIG.ra), MARIO_PAL, -HW_BIG, -H_BIG),
    spr('Bhb', holdify(BIG.rb), MARIO_PAL, -HW_BIG, -H_BIG),
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

// --------------------------------------------------------------- variants ----
//
// Each variant is an ending plus an ordered wish-list of enemy "scenes". Scenes
// only ever go into runs of fully empty weeks (so they never touch blocks); the
// list is placed in order, each scene taking the tightest empty run it fits in,
// shrinking its enemy count when it doesn't fit, and being dropped if even the
// smallest version doesn't. Placement is deterministic for a given variant + data.
//   stomp  e:'g'|'k'  one enemy walks up and gets stomped (a stomped Koopa leaves its shell)
//   kick   v:'gk..'   stomp a Koopa, kick its shell through a line of Goombas (g) / Koopas (k), into a pit
//   toss   v:'ggg'    stomp a Koopa, pick up the shell, carry it, throw it into a pack of Goombas, pit
//   rush   n          a line of Goombas stomped in one bounce chain without touching the ground
//   warp              hop into a pipe, travel underground, pop out of a pipe further right

const VARIANTS = [
  { name: 'classic', ending: 'pipe', blurb: 'kicked shell through a Goomba line into a pit, a few stomps, exit by warp pipe',
    scenes: [{ t: 'kick', v: 'gggg' }, { t: 'stomp', e: 'g' }, { t: 'stomp', e: 'g' }, { t: 'stomp', e: 'g' }] },
  { name: 'castle', ending: 'castle', blurb: 'flagpole slide and castle finish with fireworks',
    scenes: [{ t: 'kick', v: 'gg' }, { t: 'stomp', e: 'g' }, { t: 'stomp', e: 'k' }, { t: 'stomp', e: 'g' }] },
  { name: 'shell-toss', ending: 'pipe', blurb: 'Mario picks up a shell, carries it and throws it into a pack of Goombas',
    scenes: [{ t: 'toss', v: 'gggggg' }, { t: 'toss', v: 'ggg' }, { t: 'stomp', e: 'g' }] },
  { name: 'koopa-troop', ending: 'pipe', blurb: 'mostly Koopas: shells kicked into other Koopas', maxKoopas: 4,
    scenes: [{ t: 'kick', v: 'kk' }, { t: 'kick', v: 'kg' }, { t: 'stomp', e: 'k' }, { t: 'stomp', e: 'k' }] },
  { name: 'goomba-rush', ending: 'pipe', blurb: 'Goomba packs stomped in bounce chains up to 1UP', maxKoopas: 1,
    scenes: [{ t: 'rush', n: 6 }, { t: 'rush', n: 4 }, { t: 'stomp', e: 'g' }, { t: 'stomp', e: 'k' }, { t: 'stomp', e: 'g' }] },
  { name: 'warp-zone', ending: 'pipe', blurb: 'Mario dives into a mid-level pipe and pops out further right',
    scenes: [{ t: 'warp' }, { t: 'kick', v: 'gg' }, { t: 'stomp', e: 'g' }, { t: 'stomp', e: 'g' }] },
];
const CHAIN = ['100', '200', '400', '800', '1000', '1UP'];
const chainScore = (i) => CHAIN[Math.min(i, CHAIN.length - 1)];

// Column layout of a scene starting at empty column a with n enemies in its pack.
function layoutScene(s, a, n) {
  const seq = (from, step) => Array.from({ length: n }, (_, i) => from + step * i);
  switch (s.t) {
    case 'stomp': return { len: 7, ec: a + 3 };
    case 'kick': { const vs = seq(a + 6, 2); const pit = (n ? vs.at(-1) : a + 4) + 2; return { len: pit + 2 - a, k: a + 3, vs, pit }; }
    case 'toss': { const vs = seq(a + 8, 1); const pit = (n ? vs.at(-1) : a + 7) + 2; return { len: pit + 2 - a, k: a + 3, th: a + 5, vs, pit }; }
    case 'rush': { // packed 24px apart (closer than a week) so a long bounce chain fits
      const xs = Array.from({ length: n }, (_, i) => colCx(a + 3) + 24 * i);
      return { len: 3 + Math.ceil((24 * (n - 1)) / PITCH) + 4, xs };
    }
    case 'warp': return { len: 12, pa: a + 2, pb: a + 9 };
  }
  throw new Error('unknown scene ' + s.t);
}
const sceneRange = (s) => {
  const full = s.t === 'rush' ? s.n : s.v ? s.v.length : 0;
  const min = s.t === 'rush' ? 2 : s.t === 'toss' ? 1 : 0;
  return [full, min];
};
const sceneKoopas = (s, n) => (s.t === 'stomp' ? +(s.e === 'k') : s.t === 'kick' ? 1 + [...s.v.slice(0, n)].filter((x) => x === 'k').length : s.t === 'toss' ? 1 : 0);

function placeScenes(world, variant) {
  const { W, activeCount } = world;
  const free = [];
  for (let c = 0; c < W; ) {
    if (activeCount(c) === 0) {
      let b = c;
      while (b + 1 < W && activeCount(b + 1) === 0) b++;
      free.push({ a: c, b });
      c = b + 1;
    } else c++;
  }
  const placed = [];
  let koopas = 0;
  for (const s of variant.scenes) {
    const [full, min] = sceneRange(s);
    for (let n = full; n >= min; n--) {
      const kk = sceneKoopas(s, n);
      if (variant.maxKoopas !== undefined && koopas + kk > variant.maxKoopas) continue;
      const len = layoutScene(s, 0, n).len;
      const seg = free.filter((f) => f.b - f.a + 1 >= len).sort((x, y) => x.b - x.a - (y.b - y.a) || x.a - y.a)[0];
      if (!seg) continue;
      const L = layoutScene(s, seg.a, n);
      if (s.t === 'warp') { // skip as much of the empty stretch as the run allows (up to 13 weeks between pipes)
        L.pb = Math.min(seg.b - 3, seg.a + 15);
        L.len = L.pb + 3 - seg.a;
      }
      placed.push({ ...s, ...L, a: seg.a, n, v: s.v ? s.v.slice(0, n) : undefined });
      free.splice(free.indexOf(seg), 1);
      if (seg.b >= seg.a + L.len) free.push({ a: seg.a + L.len, b: seg.b });
      koopas += kk;
      break;
    }
  }
  return placed.sort((x, y) => x.a - y.a);
}

// Small deterministic PRNG for cosmetics (mulberry32) seeded from a string.
function rng(seedStr) {
  let h = 1779033703;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ planner ----

function plan(world, scenes, k, variant) {
  const { W, grid } = world;
  const width = variant.ending === 'castle' ? castleGeom(W).width : world.width;
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

  // ---- enemy actors: scripted paths in time, rendered generically.
  // pos: [t, dx, dy, ease] relative to the anchor (feet centre on the ground),
  // modes: [t, mode] (g walk / sq squished / fl flipped; k walk / sh shell / kf, sf flipped),
  // op: [t, opacity]. Everything is reset during the restore phase.
  const actors = [];
  const actor = (kind, ax) => {
    const A = { kind, ax, pos: [[0, 0, 0, 'l']], modes: [[0, kind]], op: [[0, 1]] };
    actors.push(A);
    return A;
  };
  const walkIn = (A, tm) => { A.pos = [[0, 24, 0, 'l'], [Math.max(0.01, tm - 2 * k), 24, 0, 'l'], [tm, 0, 0, 'l']]; };
  const squish = (A, tm) => { A.modes.push([tm + 0.03 * k, 'sq']); A.op.push([tm + 0.7, 1], [tm + 0.9, 0]); };
  const knock = (A, th, dx) => {
    const m = A.modes.at(-1)[1];
    A.pos.push([th, dx, 0, 'u'], [th + 0.17, dx + 6, -14, 'd'], [th + 0.75, dx + 14, 70, 'l']);
    A.modes.push([th, m === 'g' ? 'fl' : m === 'sh' ? 'sf' : 'kf']);
    A.op.push([th + 0.75, 1], [th + 0.76, 0]);
  };
  const pits = [];
  const pipes = [LPX];
  const vis = [[0, 1]]; // Mario visibility
  const counts = { goombas: 0, koopas: 0, kills: 0 };

  const stomp = (xm, hE) => {
    const hUp = hE + 12;
    const tu = Math.sqrt((2 * hUp) / g), td = Math.sqrt((2 * 12) / g);
    const D = vRun * (tu + td);
    runTo(xm - D);
    hop(hUp, -hE, [[0, xm - D], [tu + td, xm]]);
    return t; // contact time
  };
  const bounceOn = (xm, back = false) => {
    const tu = Math.sqrt((2 * 20) / g), td = Math.sqrt((2 * (y * -1 + 20)) / g);
    hop(20, 0, [[0, xm], [tu + td, back ? xm - 20 : xm + vRun * (tu + td)]]);
  };
  const pitJump = (pc) => {
    const px = colCx(pc), half = 18;
    runTo(px - half);
    const tAir = (2 * half) / vRun;
    hop(Math.max(10, (g * (tAir / 2) ** 2) / 2), 0, [[0, px - half], [tAir, px + half]]);
  };
  // Hop from the ground onto a pipe at px, clearing its lip, landing on top.
  const pipeHopOn = (px) => {
    runTo(px - 22.5);
    const tu = Math.sqrt((2 * 48) / g), td = Math.sqrt((2 * 18) / g);
    hop(48, -PIPE_H, [[0, px - 22.5], [tu, px - 18], [tu + td, px]]);
  };
  // A shell sliding right from (x0, t0), knocking out pack members, falling into a pit.
  const slide = (S, t0, x0, pack, pitCol) => {
    S.pos.push([t0, x0 - S.ax, 0, 'l']);
    pack.forEach(({ A, vx }, i) => {
      const th = t0 + (vx - 15 - x0) / vShell;
      knock(A, th, 0);
      counts.kills++;
      pops.push({ x: vx, y: GROUND - 26, t: th, txt: chainScore(i) });
    });
    const px = colCx(pitCol);
    pits.push(px);
    const tf = t0 + (px - x0) / vShell, fall = 0.3 * k;
    S.pos.push([tf, px - S.ax, 0, 'd'], [tf + fall, px - S.ax + vShell * fall * 0.6, 40, 'l']);
    S.op.push([tf + fall, 1], [tf + fall + 0.01, 0]);
  };
  const makePack = (s) => (s.v ?? 'g'.repeat(s.vs.length)).split('').map((kind, i) => {
    const vx = colCx(s.vs[i]);
    counts[kind === 'g' ? 'goombas' : 'koopas']++;
    return { A: actor(kind, vx), vx };
  });

  const scene = (s) => {
    if (s.t === 'stomp') {
      const xm = colCx(s.ec), kind = s.e;
      const A = actor(kind, xm);
      counts[kind === 'g' ? 'goombas' : 'koopas']++;
      const tm = stomp(xm, kind === 'g' ? GOOMBA_H : KOOPA_H);
      walkIn(A, tm);
      if (kind === 'g') squish(A, tm); else A.modes.push([tm, 'sh']);
      counts.kills += kind === 'g';
      pops.push({ x: xm, y: GROUND - 26, t: tm, txt: '100' });
      bounceOn(xm);
    } else if (s.t === 'kick' || s.t === 'toss') {
      const xm = colCx(s.k);
      const K = actor('k', xm);
      counts.koopas++;
      const pack = makePack(s);
      const tm = stomp(xm, KOOPA_H);
      walkIn(K, tm);
      K.modes.push([tm, 'sh']);
      pops.push({ x: xm, y: GROUND - 28, t: tm, txt: '100' });
      bounceOn(xm, true); // bounce back off the shell
      wait(0.12 * k);
      runTo(xm - HW_BIG - 7.5); // touch the shell
      if (s.t === 'kick') {
        slide(K, t, xm, pack, s.pit);
        wait(0.08 * k);
      } else {
        // pick the shell up and carry it in front (held at hand height), then throw it
        const tg = t, xth = colCx(s.th), hold = HW_BIG + 2.5, hy = -9;
        wait(0.1 * k, 'ho');
        K.pos.push([tg, 0, 0, 'l'], [t, x + hold - xm, hy, 'l']);
        runTo(xth, 'hr');
        K.pos.push([t, xth + hold - xm, hy, 'l']);
        wait(0.15 * k, 'ho');
        const tt = t, drop = 0.08 * k;
        K.pos.push([tt, xth + hold - xm, hy, 'd']);
        const xl = xth + hold + vShell * drop;
        K.pos.push([tt + drop, xl - xm, 0, 'l']);
        pose('st');
        slide(K, tt + drop, xl, pack, s.pit);
        wait(0.2 * k);
      }
      pitJump(s.pit);
    } else if (s.t === 'rush') {
      const pack = s.xs.map((vx) => { counts.goombas++; return { A: actor('g', vx), vx }; });
      pack.forEach(({ A, vx }, i) => {
        let tm;
        if (i === 0) tm = stomp(vx, GOOMBA_H);
        else {
          const tu = Math.sqrt((2 * 20) / g);
          hop(20, -GOOMBA_H, [[0, pack[i - 1].vx], [2 * tu, vx]]);
          tm = t;
        }
        squish(A, tm);
        counts.kills++;
        pops.push({ x: vx, y: GROUND - 26, t: tm, txt: chainScore(i) });
      });
      bounceOn(pack.at(-1).vx);
    } else if (s.t === 'warp') {
      const xa = colCx(s.pa), xb = colCx(s.pb);
      pipes.push(xa, xb);
      pipeHopOn(xa);
      wait(0.25 * k);
      Y.push({ t, y, e: 'l' });
      t += 0.6 * k;
      yk(0); // sunk into pipe A (hidden behind it)
      vis.push([t, 0]);
      xk(xa);
      t += 0.4 * k; // underground
      xk(xb);
      vis.push([t, 1]);
      Y.push({ t, y: 0, e: 'l' });
      t += 0.6 * k;
      yk(-PIPE_H); // risen out of pipe B
      wait(0.15 * k);
      const tu = Math.sqrt(20 / g);
      hop(10, 0, [[0, xb], [tu, xb + 21], [tu + Math.sqrt((2 * (PIPE_H + 10)) / g), xb + 24]]);
    }
  };

  // ---- stations, left to right
  const stations = [];
  for (let c = 0; c < W; c++) if (world.activeCount(c)) stations.push({ c, col: true });
  for (const s of scenes) stations.push({ c: s.a, s });
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

  for (const st of stations) {
    if (st.col) doColumn(st.c);
    else scene(st.s);
  }

  // ---- ending
  let castle = null;
  if (variant.ending === 'castle') {
    // Flagpole: jump high onto the pole, slide down with the flag, hop off the
    // base block, walk into the castle door; the castle flag rises, fireworks.
    const { poleX, castleX } = castleGeom(W);
    const grab = poleX - 6, hJ = 55;
    const tu = Math.sqrt((2 * hJ) / g);
    runTo(grab - vRun * tu);
    xk(x);
    pose('jp');
    const t0 = t;
    Y.push({ t: t0, y: 0, e: 'u' });
    t = t0 + tu;
    X.push({ t, x: grab });
    x = grab;
    yk(-hJ);
    const tGrab = t;
    pose('pl');
    t += 0.12 * k;
    yk(-hJ);
    t += (hJ - 15) / (70 / k);
    yk(-15); // on top of the base block
    const tSlid = t;
    wait(0.25 * k, 'pl');
    {
      const tu2 = Math.sqrt(20 / g), td2 = Math.sqrt(50 / g);
      hop(10, 0, [[0, grab], [tu2, poleX + 16], [tu2 + td2, poleX + 22]]);
    }
    const door = castleX + 35;
    runTo(door);
    const tEnter = t;
    vis.push([t + 0.15 * k, 0]);
    t += 0.5 * k;
    const tFlag0 = t;
    t += 0.9 * k;
    const tFlag1 = t;
    const fireworks = [0, 1, 2].map((i) => ({ t: t + i * 0.45 * k, x: castleX + 12 + i * 23, y: GROUND - 95 + (i % 2) * 14 }));
    t += 1.6 * k;
    castle = { poleX, castleX, tGrab, tSlid, tEnter, tFlag0, tFlag1, fireworks };
  } else {
    // hop onto the right pipe (clearing the lip), sink in
    pipes.push(RPX);
    pipeHopOn(RPX);
    wait(0.35 * k);
    Y.push({ t, y: -PIPE_H, e: 'l' });
    t += 0.9 * k;
    yk(0);
  }
  const tEnd = t;
  const T = Math.round(((tEnd + HOLD_END) / RESTORE) * 10 + 0.5) / 10;
  Y.push({ t: T, y, e: 'l' });
  X.push({ t: T, x });
  if (castle) vis.push([T, 0]);

  return { T, X, Y, poses, lifts, pops, stats, ev, growT0, growT1, LPX, RPX, IB, k, actors, pits, pipes, vis, castle, counts, width, variant: variant.name };
}

function castleGeom(W) {
  const gridRight = GX + W * PITCH - 3;
  const poleX = gridRight + 40;
  const castleX = poleX + 26;
  return { poleX, castleX, width: castleX + 78 };
}

// --------------------------------------------------------------- render ----

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const r2 = (n) => +n.toFixed(2);
const EASE = { u: 'cubic-bezier(.33,.67,.67,1)', d: 'cubic-bezier(.33,0,.67,.33)' };

function render(cal, user, themeName, P, world) {
  const th = THEMES[themeName];
  const { W } = world;
  const width = P.width;
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

  // ---- enemies (generic actors)
  const EASE2 = { u: EASE.u, d: EASE.d };
  const MODE_SVG = {
    g: '<use href="#gm" class="gw"/>',
    sq: '<g transform="scale(1 .35)"><use href="#gm"/></g>',
    fl: `<g transform="matrix(1 0 0 -1 0 -${GOOMBA_H})"><use href="#gm"/></g>`,
    k: '<use href="#kp" class="kw"/>',
    sh: '<use href="#sh"/>',
    kf: `<g transform="matrix(1 0 0 -1 0 -${KOOPA_H})"><use href="#kp"/></g>`,
    sf: `<g transform="matrix(1 0 0 -1 0 -${SHELL_H})"><use href="#sh"/></g>`,
  };
  const enemySvg = P.actors.map((A, j) => {
    const pos = [...A.pos].sort((a, b) => a[0] - b[0]);
    const op = [...A.op].sort((a, b) => a[0] - b[0]);
    const last = pos.at(-1), first = pos[0];
    const lastOp = op.at(-1)[1];
    const fr = [
      ...pos.map(([t, x, y, e]) => [t, tr(x, y) + (e !== 'l' ? ';animation-timing-function:' + EASE2[e] : '')]),
      ...op.map(([t, o]) => [t, `opacity:${o}`]),
      [TR - 0.25, `${tr(last[1], last[2])};opacity:${lastOp}`], [TR, `${tr(first[1], first[2])};opacity:0`], [T, `${tr(first[1], first[2])};opacity:1`],
    ];
    css.push(kf('A' + j, fr));
    const used = [...new Set(A.modes.map((m) => m[1]))];
    const init = A.modes[0][1];
    const inner = used.length === 1 ? MODE_SVG[init] : used.map((m) => {
      const f = A.modes.map(([t, q]) => [t, `opacity:${q === m ? 1 : 0}`]);
      f.push([TR, `opacity:${m === init ? 1 : 0}`], [T, `opacity:${m === init ? 1 : 0}`]);
      css.push(kf(`M${j}${m}`, f));
      return `<g class="a s${m === init ? '' : ' o'}" ${an(`M${j}${m}`)}>${MODE_SVG[m]}</g>`;
    }).join('');
    return `<g transform="translate(${r2(A.ax)} ${GROUND})"><g class="a" ${an('A' + j)}>${inner}</g></g>`;
  }).join('');

  // ---- score popups
  const popSvg = P.pops.map(({ x, y, t, txt }) =>
    `<text class="a e o pp sc" ${dl(t)} x="${r2(x)}" y="${r2(y)}" text-anchor="middle">${txt}</text>`).join('');

  // ---- Mario
  css.push(kf('mx', P.X.map(({ t, x }) => [t, `transform:translateX(${r2(x)}px)`])));
  css.push(kf('my', P.Y.map(({ t, y, e }) => [t, `transform:translateY(${r2(y)}px)${e !== 'l' ? ';animation-timing-function:' + EASE[e] : ''}`])));
  const POSES = ['st', 'rn', 'jp', 'cr', 'ho', 'hr', 'pl'];
  const usedPoses = new Set(P.poses.map((p) => p.p));
  for (const p of POSES) {
    if (!usedPoses.has(p)) continue;
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
  const SPR_OF = {
    s: { st: '#sst', rn: ['#sra', '#srb'], jp: '#sjp', cr: '#sst', ho: '#sst', hr: ['#sra', '#srb'], pl: '#sjp' },
    B: { st: '#Bst', rn: ['#Bra', '#Brb'], jp: '#Bjp', cr: '#Bcr', ho: '#Bho', hr: ['#Bha', '#Bhb'], pl: '#Bjp' },
  };
  const poseSet = (pre) => POSES.filter((p) => usedPoses.has(p)).map((p) => {
    const s = SPR_OF[pre][p];
    const body = Array.isArray(s) ? `<use href="${s[0]}" class="fa"/><use href="${s[1]}" class="fb"/>` : `<use href="${s}"/>`;
    return `<g class="a s${p === 'st' ? '' : ' o'}" ${an('z' + p)}>${body}</g>`;
  }).join('');
  let marioOuter = `transform="translate(0 ${GROUND})"`;
  if (P.vis.length > 1) {
    css.push(kf('mv', P.vis.map(([t, o]) => [t, `opacity:${o}`])));
    marioOuter += ` class="a s" ${an('mv')}`;
  }
  const mario = `<g ${marioOuter}><g class="a" ${an('mx')}><g class="a" ${an('my')}>` +
    `<g class="a s" ${an('zS')}>${poseSet('s')}</g><g class="a s o" ${an('zB')}>${poseSet('B')}</g></g></g></g>`;

  // ---- scenery (deterministic per variant + data)
  const rand = rng(`${P.variant}|${cal.totalContributions}|${W}`);
  const clouds = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => {
    const y = rand() < 0.35 ? GY + 10 + rand() * 50 : GRID_BOTTOM + rand() * 14;
    const s = 0.7 + rand() * 0.6;
    return `<g transform="translate(0 ${r2(y)}) scale(${r2(s)})"><use href="#cl" class="cl" style="animation-delay:-${r2(rand() * 90)}s"/></g>`;
  }).join('');
  const hillFill = themeName === 'dark' ? '#16301c' : '#00a800';
  const hillDot = themeName === 'dark' ? '#0f2414' : '#005800';
  const bushFill = themeName === 'dark' ? '#1b3a22' : '#80d010';
  const deco = [];
  for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
    const w = 46 + rand() * 40, h = 14 + rand() * 14, x0 = rand() * (width - w);
    deco.push(`<path fill="${hillFill}" d="M${r2(x0)} ${GROUND}q${r2(w / 2)} ${r2(-2 * h)} ${r2(w)} 0z"/>` +
      `<path fill="${hillDot}" d="M${r2(x0 + w / 2 - 6)} ${r2(GROUND - h * 0.7)}h2v4h-2zM${r2(x0 + w / 2 + 3)} ${r2(GROUND - h * 0.55)}h2v4h-2z"/>`);
  }
  for (let i = 0, n = 2 + Math.floor(rand() * 3); i < n; i++) {
    const x0 = rand() * (width - 40), s = 0.6 + rand() * 0.5;
    deco.push(`<g transform="translate(${r2(x0)} ${r2(GROUND - 9 * s)}) scale(${r2(s)})" fill="${bushFill}"><circle cx="8" cy="8" r="7"/><circle cx="18" cy="5" r="8"/><circle cx="28" cy="8" r="7"/><rect x="4" y="8" width="28" height="7"/></g>`);
  }
  const pipeTop = GROUND - PIPE_H;
  const pipes = P.pipes.map((px) => `<use href="#pp" x="${r2(px - 13)}" y="${pipeTop}"/>`).join('');
  // ground with pits
  const pitRanges = P.pits.map((px) => [px - 10, px + 10]).sort((a, b) => a[0] - b[0]);
  let gx0 = 0;
  const groundSvg = [];
  for (const [a, b] of [...pitRanges, [width, width]]) {
    if (a > gx0) groundSvg.push(`<rect x="${r2(gx0)}" y="${GROUND}" width="${r2(a - gx0)}" height="${GROUND_H}" fill="url(#gt)"/>`);
    gx0 = b;
  }

  // ---- castle ending
  let castleBack = '', castleFront = '';
  if (P.castle) {
    const C = P.castle, top = GY + 4, cx0 = C.castleX;
    const flagDrop = GROUND - 15 - 14 - (top + 6);
    css.push(kf('fg', [[0, 'transform:none'], [C.tGrab, 'transform:none'], [C.tSlid, `transform:translateY(${r2(flagDrop)}px)`], [TR, `transform:translateY(${r2(flagDrop)}px)`], [T, 'transform:none']]));
    css.push(kf('cf', [[0, 'transform:none'], [C.tFlag0, 'transform:none'], [C.tFlag1, 'transform:translateY(-26px)'], [TR, 'transform:translateY(-26px)'], [T, 'transform:none']]));
    css.push(`.fw{animation-name:fw;transform-box:fill-box;transform-origin:center}`);
    css.push(kf('fw', [[0, 'opacity:0;transform:scale(.2)'], [0.01, 'opacity:1;transform:scale(.3);animation-timing-function:ease-out'], [0.5, 'opacity:1;transform:scale(1.3)'], [0.75, 'opacity:0;transform:scale(1.5)'], [T, 'opacity:0;transform:scale(1.5)']]));
    const burst = (c) => Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      return `<circle cx="${r2(Math.cos(a) * 9)}" cy="${r2(Math.sin(a) * 9)}" r="1.6" fill="${c}"/>`;
    }).join('') + `<circle r="2" fill="#fff"/>`;
    const fwColors = ['#fcd000', '#fc7460', '#fcfcfc'];
    const fireworks = C.fireworks.map((f, i) => `<g transform="translate(${r2(f.x)} ${r2(f.y)})"><g class="a e o fw" ${dl(f.t)}>${burst(fwColors[i % 3])}</g></g>`).join('');
    const lw = 70;
    const crenel = (x0, y0, w) => Array.from({ length: Math.floor(w / 10) + 1 }, (_, i) => `M${r2(x0 + i * 10)} ${y0}h6v6h-6z`).join('');
    castleBack =
      // castle flag first, so it starts hidden behind the tower and rises out of it
      `<g class="a" ${an('cf')}><path fill="#fcfcfc" d="M${cx0 + 35} ${GROUND - 42}h1v-14h-1z"/><path fill="#d82800" d="M${cx0 + 36} ${GROUND - 55}l9 3l-9 3z"/></g>` +
      // castle body: lower hall + tower, brick texture, crenellations, door and windows
      `<rect x="${cx0}" y="${GROUND - 34}" width="${lw}" height="34" fill="url(#gt)"/>` +
      `<rect x="${cx0 + 16}" y="${GROUND - 58}" width="${lw - 32}" height="24" fill="url(#gt)"/>` +
      `<path fill="url(#gt)" d="${crenel(cx0, GROUND - 40, lw - 6)}${crenel(cx0 + 16, GROUND - 64, lw - 38)}"/>` +
      `<path fill="#000" d="M${cx0 + 28} ${GROUND}v-12a7 7 0 0 1 14 0v12zM${cx0 + 24} ${GROUND - 52}h6v10h-6zM${cx0 + 40} ${GROUND - 52}h6v10h-6z"/>` +
      // flagpole, ball, base block, sliding flag
      `<rect x="${C.poleX - 1}" y="${top}" width="2" height="${GROUND - 15 - top}" fill="#80d010"/>` +
      `<circle cx="${C.poleX}" cy="${top - 2}" r="3.2" fill="#00a800" stroke="#000" stroke-width=".6"/>` +
      `<rect x="${C.poleX - 7.5}" y="${GROUND - 15}" width="15" height="15" fill="${themeName === 'dark' ? '#4a5568' : '#9c4a00'}" stroke="#000"/>` +
      `<g class="a" ${an('fg')}><path fill="#fcfcfc" stroke="#00a800" d="M${C.poleX - 1} ${top + 6}l-14 7l14 7z"/><circle cx="${C.poleX - 6}" cy="${top + 13}" r="2" fill="#00a800"/></g>`;
    castleFront = fireworks;
  }

  const lastDay = cal.weeks.at(-1)?.contributionDays.at(-1)?.date ?? new Date().toISOString();
  const hud = `<g class="hud"><text x="8" y="12">${esc(user.toUpperCase())}</text>` +
    `<text x="${r2(width / 2)}" y="12" text-anchor="middle">COINS ×${cal.totalContributions}</text>` +
    `<text x="${width - 8}" y="12" text-anchor="end">WORLD ${lastDay.slice(0, 4)}</text></g>`;

  const title = `${user}: ${cal.totalContributions} contributions in the last year, as a Super Mario Bros level (${P.variant})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><defs>${defs(th)}</defs><style>${css.join('')}</style>` +
    `<rect width="${width}" height="${HEIGHT}" fill="${th.bg}"/>${clouds}${deco.join('')}${castleBack}` +
    `<g shape-rendering="crispEdges">${gridSvg.join('')}</g>${introSvg}${liftSvg.join('')}${enemySvg}${mario}` +
    `<g shape-rendering="crispEdges">${debris.join('')}</g>${items.join('')}${pipes}${groundSvg.join('')}${castleFront}${popSvg}${hud}</svg>\n`;
}

// --------------------------------------------------------------- driver ----

const VARIANT_NAMES = VARIANTS.map((v) => v.name);
const ROTATION_MS = 12 * 3600 * 1000;
const autoVariant = (now = Date.now()) => VARIANT_NAMES[Math.floor(now / ROTATION_MS) % VARIANT_NAMES.length];

function generate(cal, user, variantName = 'classic') {
  const variant = VARIANTS.find((v) => v.name === variantName);
  if (!variant) throw new Error(`unknown variant "${variantName}" (have: ${VARIANT_NAMES.join(', ')})`);
  // Plan at natural speed; if the loop is too long, speed everything up uniformly.
  const make = (k) => {
    const world = buildWorld(cal);
    const scenes = placeScenes(world, variant);
    return { world, scenes, P: plan(world, scenes, k, variant) };
  };
  let r = make(1);
  if (r.P.T > TARGET_T) {
    let k = TARGET_T / r.P.T;
    for (let i = 0; i < 6; i++) {
      r = make(k);
      if (r.P.T <= MAX_T) break;
      k *= (MAX_T / r.P.T) * 0.98;
    }
  }
  return r;
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' }, out: { type: 'string', default: 'dist' }, data: { type: 'string' },
      variant: { type: 'string', default: 'auto' }, all: { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
    },
  });
  if (values.list) {
    for (const v of VARIANTS) console.log(`${v.name.padEnd(12)} ${v.blurb}`);
    console.log(`auto -> ${autoVariant()} (rotates every 12h: floor(now / 12h) % ${VARIANTS.length})`);
    return;
  }
  if (!values.user) {
    console.error('usage: node mario-graph.mjs --user <login> [--out dist] [--data contrib.json] [--variant <name>|auto] [--all] [--list]');
    process.exit(2);
  }
  const chosen = values.variant === 'auto' ? autoVariant() : values.variant;
  if (!VARIANT_NAMES.includes(chosen)) {
    console.error(`unknown variant "${chosen}"; use --list (have: ${VARIANT_NAMES.join(', ')})`);
    process.exit(2);
  }
  const json = values.data ? JSON.parse(await readFile(values.data, 'utf8')) : await fetchCalendar(values.user);
  const cal = extractCalendar(json);
  await mkdir(values.out, { recursive: true });

  const jobs = [[chosen, 'mario-contribution-graph']];
  if (values.all) for (const n of VARIANT_NAMES) jobs.push([n, `mario-${n}`]);
  const cache = new Map();
  for (const [name, base] of jobs) {
    if (!cache.has(name)) cache.set(name, generate(cal, values.user, name));
    const { P, world } = cache.get(name);
    for (const [theme, suffix] of [['light', ''], ['dark', '-dark']]) {
      // render adds the block mushrooms' "1000"s to pops; render each from a fresh copy
      const svg = render(cal, values.user, theme, { ...P, pops: [...P.pops] }, world);
      const path = join(values.out, `${base}${suffix}.svg`);
      await writeFile(path, svg);
      console.log(`wrote ${path} (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`);
    }
    if (base === 'mario-contribution-graph' || values.all) {
      const s = P.stats, c = P.counts;
      console.log(`[${name}] loop ${P.T}s (speed x${(1 / P.k).toFixed(2)}), ${world.cells.length} blocks: ${s.direct} direct, ${s.chain} via used block, ` +
        `${s.gap} across a gap, ${s.side} from a side lift; ${s.lift} lift jumps on ${P.lifts.size} lifts; ` +
        `${c.goombas} goombas, ${c.koopas} koopas, ${c.kills} knocked out` + (s.gapCells ? `; gap hits: ${s.gapCells.join(', ')}` : ''));
    }
  }
}

// Exported for tests / plan validation; the CLI only runs when executed directly.
export { extractCalendar, generate, render, VARIANTS, VARIANT_NAMES, autoVariant };
export const LAYOUT = { CELL, PITCH, GX, GY, GRID_BOTTOM, GROUND, PIPE_H, H_SMALL, H_BIG, HW_SMALL, HW_BIG, JMAX, GOOMBA_H, KOOPA_H, RESTORE };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? err);
    process.exit(1);
  });
}

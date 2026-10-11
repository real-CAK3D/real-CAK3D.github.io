#!/usr/bin/env node
// Super Mario Bros-styled GitHub contribution graph generator.
// Zero dependencies, Node 22+, ESM. Output is a self-contained animated SVG
// (pure CSS @keyframes, no JS, no external fonts/images) suitable for <img>.
//
//   node .github/mario/mario-graph.mjs --user <login> --out dist [--data contrib.json]
//
// Without --data, the calendar is fetched from the GitHub GraphQL API using
// the GITHUB_TOKEN environment variable.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------- data ----

const QUERY = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{contributionCount contributionLevel weekday date}}}}}}`;

async function fetchCalendar(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set (or pass --data <file.json>)');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mario-contribution-graph',
    },
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
const GX = 50; // grid left (room for the left warp pipe)
const GY = 22; // grid top (HUD strip above)
const GRID_BOTTOM = GY + 6 * PITCH + CELL; // 124
const GROUND = GRID_BOTTOM + 52; // 176: top of the ground strip (lane in between)
const GROUND_H = 16;
const HEIGHT = GROUND + GROUND_H; // 192
const MARIO_H = 20; // 16px * 1.25
const HIT_Y = GRID_BOTTOM + 1 - (GROUND - MARIO_H); // head just under the grid
const PIPE_H = 30; // pipe top is GROUND - PIPE_H
const STEP = 0.28; // seconds per week column
const LAND = 1.8; // Mario lands on the lane after the intro hop
const ROW_STAGGER = 0.045;
const RESTORE = 0.97; // blocks fade back in during the last 3% of the loop

// --------------------------------------------------------------- themes ----

const THEMES = {
  light: {
    bg: '#5c94fc', empty: '#ffffff', emptyOp: 0.18,
    brick: ['#d8703a', '#c84c0c'], mortar: '#000000', hi: '#fcbcb0',
    q: '#fca044', qDark: '#000000', qGlyph: '#7c2800', used: '#9c4a00', coin: '#fcd000',
    ground: '#c84c0c', groundMortar: '#000000', groundHi: '#fcbcb0',
    cloud: '#ffffff', cloudOp: 1, hud: '#ffffff', hudShadow: '#000000',
  },
  dark: {
    bg: '#0d1117', empty: '#161b22', emptyOp: 1,
    brick: ['#1d4a8f', '#2860b8'], mortar: '#0a1630', hi: '#6fa0ff',
    q: '#fca044', qDark: '#000000', qGlyph: '#7c2800', used: '#9c4a00', coin: '#fcd000',
    ground: '#1d4a8f', groundMortar: '#0a1630', groundHi: '#6fa0ff',
    cloud: '#8b949e', cloudOp: 0.18, hud: '#e6edf3', hudShadow: '#000000',
  },
};

// ------------------------------------------------------------- sprites ----

// Pixel rows -> one <path> per colour, merging horizontal runs.
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

const MARIO_TOP = [
  '...RRRRR....',
  '..RRRRRRRRR.',
  '..BBBSSBS...',
  '.BSBSSSBSSS.',
  '.BSBBSSSBSSS',
  '.BBSSSSBBBB.',
  '...SSSSSSS..',
];
const MARIO_STAND = [...MARIO_TOP,
  '..BBRBBB....',
  '.BBBRBBRBBB.',
  'BBBBRRRRBBBB',
  'SSBRSRRSRBSS',
  'SSSRRRRRRSSS',
  'SSRRRRRRRRSS',
  '..RRR..RRR..',
  '.BBB....BBB.',
  'BBBB....BBBB',
];
const MARIO_RUN_A = [...MARIO_TOP,
  '..BBBBRB....',
  '.BBBBRRBBS..',
  'SBBBRRRRBSS.',
  'SSSRSRRSRSS.',
  'SSRRRRRRRR..',
  '..RRRRRRRRR.',
  '.RRRR...RRR.',
  'BBBB.....BBB',
  '.BBBB....BB.',
];
const MARIO_RUN_B = [...MARIO_TOP,
  '...BBRBB....',
  '..BBBRRBB...',
  '..BBRRSRR...',
  '..BBRRRRR...',
  '..SSRRRRR...',
  '..SSRRRRR...',
  '...RRRRR....',
  '...BBBBBB...',
  '...BBBB.....',
];
const MARIO_JUMP = [
  '...RRRRR..SS',
  '..RRRRRRRRSS',
  '..BBBSSBS.BB',
  '.BSBSSSBSSBB',
  '.BSBBSSSBSSB',
  '.BBSSSSBBBB.',
  '...SSSSSSSB.',
  '..BBRBBBRB..',
  '.BBBRBBBRB..',
  'BBBBRRRRRB..',
  'SSBRSRRSRR..',
  'SSRRRRRRRR..',
  '..RRRRRRRRR.',
  '.RRRR..RRRR.',
  'BBBB....BBB.',
  'BBB.........',
];
const MARIO_PAL = { R: '#d82800', B: '#6b3c00', S: '#fcb07c' };

const GOOMBA = [
  '......BBBB......',
  '.....BBBBBB.....',
  '....BBBBBBBB....',
  '...KKBBBBBBKK...',
  '..BBWKKBBKKWBB..',
  '.BBBWKWBBWKWBBB.',
  '.BBBWWWBBWWWBBB.',
  'BBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBB',
  '.BBBBTTTTTTBBBB.',
  '......TTTT......',
  '.....TTTTTT.....',
  '...KKTTTTTTK....',
  '..KKKKTTTTKKKK..',
  '..KKKKK..KKKKK..',
  '...KKK....KKK...',
];
const GOOMBA_PAL = { B: '#a0420c', T: '#f8c890', K: '#000000', W: '#ffffff' };

const Q_GLYPH = [
  '............',
  '............',
  '....GGGG....',
  '...GG..GG...',
  '.......GG...',
  '......GG....',
  '.....GG.....',
  '.....GG.....',
  '............',
  '.....GG.....',
  '............',
  '............',
];

function defs(th) {
  const brick = (fill, id) =>
    `<g id="${id}"><rect width="12" height="12" fill="${fill}"/>` +
    `<path fill="${th.hi}" d="M0 0h12v1H0zM0 6h12v1H0z"/>` +
    `<path fill="${th.mortar}" d="M0 5h12v1H0zM0 11h12v1H0zM5 0h1v5H5zM2 6h1v5H2zM9 6h1v5H9z"/></g>`;
  const rivets = (c) => `<path fill="${c}" d="M1 1h1v1H1zM10 1h1v1h-1zM1 10h1v1H1zM10 10h1v1h-1z"/>`;
  return [
    `<rect id="e" width="12" height="12" rx="2" fill="${th.empty}"${th.emptyOp < 1 ? ` fill-opacity="${th.emptyOp}"` : ''}/>`,
    brick(th.brick[0], 'b1'),
    brick(th.brick[1], 'b2'),
    // ? block
    `<g id="q"><rect x=".5" y=".5" width="11" height="11" fill="${th.q}" stroke="${th.qDark}"/>` +
      `<path fill="#fcd8a8" d="M1 1h10v1H1zM1 2h1v9H1z"/>` + rivets(th.qDark) +
      pixelArt(Q_GLYPH.map((r) => r), { G: th.qGlyph }) + `</g>`,
    // used block
    `<g id="u"><rect x=".5" y=".5" width="11" height="11" fill="${th.used}" stroke="#000"/>${rivets('#000')}</g>`,
    // brick debris chunk
    `<rect id="k" width="5" height="5" fill="${th.brick[1]}" stroke="${th.mortar}" stroke-width=".8"/>`,
    // coin
    `<g id="cn"><rect x="2.5" y=".5" width="7" height="11" rx="3" fill="${th.coin}" stroke="#7a4a00"/><rect x="5" y="3" width="2" height="6" fill="#fff4a0"/></g>`,
    // super mushroom
    `<g id="mu" stroke="#000" stroke-width=".7"><rect x="3" y="6.5" width="6" height="5" rx="1.5" fill="#fcd8a8"/>` +
      `<path d="M.6 7.4Q.6.4 6 .4t5.4 7z" fill="#d82800"/>` +
      `<g fill="#fff" stroke="none"><circle cx="3.3" cy="4.4" r="1.6"/><circle cx="8.7" cy="4.4" r="1.6"/><circle cx="6" cy="1.9" r="1.1"/></g>` +
      `<path stroke="none" fill="#000" d="M4.6 8h.9v2h-.9zM6.5 8h.9v2h-.9z"/></g>`,
    // Mario frames (origin = feet centre)
    ...[['ms', MARIO_STAND], ['ma', MARIO_RUN_A], ['mb', MARIO_RUN_B], ['mj', MARIO_JUMP]].map(
      ([id, rows]) => `<g id="${id}" transform="translate(-7.5 -20) scale(1.25)">${pixelArt(rows, MARIO_PAL)}</g>`,
    ),
    `<g id="gm">${pixelArt(GOOMBA, GOOMBA_PAL)}</g>`,
    // warp pipe, origin = lip top-left, 26 wide
    `<g id="pp"><rect x="2" y="10" width="22" height="${PIPE_H - 10}" fill="#00a800" stroke="#000"/>` +
      `<path fill="#80d010" d="M5 10h3v${PIPE_H - 10}H5z"/><path fill="#005800" d="M18 10h2v${PIPE_H - 10}h-2zM21 10h2v${PIPE_H - 10}h-2z"/>` +
      `<rect x=".5" y=".5" width="25" height="9.5" fill="#00a800" stroke="#000"/>` +
      `<path fill="#80d010" d="M3 1h3v9H3z"/><path fill="#005800" d="M19 1h2v9h-2zM22 1h2v9h-2z"/></g>`,
    // cloud
    `<g id="cl" fill="${th.cloud}"${th.cloudOp < 1 ? ` opacity="${th.cloudOp}"` : ''}><circle cx="10" cy="8" r="6"/><circle cx="19" cy="5" r="7"/><circle cx="28" cy="8" r="6"/><rect x="6" y="8" width="26" height="6" rx="3"/></g>`,
    // ground tile pattern
    `<pattern id="gt" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="${th.ground}"/>` +
      `<path fill="${th.groundHi}" d="M0 0h16v1H0zM0 8h16v1H0zM0 1h1v7H0zM8 9h1v7H8z"/>` +
      `<path fill="${th.groundMortar}" d="M0 7h16v1H0zM0 15h16v1H0zM15 0h1v7h-1zM7 8h1v7H7z"/></pattern>`,
  ].join('');
}

// ------------------------------------------------------------ timeline ----

const r3 = (n) => +n.toFixed(3);

function buildTimeline(weeks) {
  const W = weeks.length;
  const width = GX + W * PITCH + 40;
  const speed = PITCH / STEP;
  const cx = (c) => GX + c * PITCH + 6;
  const tc = (c) => LAND + STEP * (c + 1);
  const weekTotals = weeks.map((w) => w.reduce((s, d) => s + (d ? d.count : 0), 0));
  const LPX = 15;
  const RPX = width - 19;

  // Goombas: fully empty weeks with empty neighbours (+-2, relax to +-1).
  const isEmpty = (c) => c >= 0 && c < W && weekTotals[c] === 0;
  let goombas = [];
  for (const radius of [2, 1]) {
    const cand = [];
    for (let c = 2; c < W - 2; c++) {
      let ok = true;
      for (let k = -radius; k <= radius; k++) if (!isEmpty(c + k)) ok = false;
      if (ok) cand.push(c);
    }
    if (!cand.length) continue;
    const want = Math.min(3, cand.length);
    const picked = [];
    for (let i = 0; i < want; i++) {
      const c = cand[Math.floor(((i + 0.5) * cand.length) / want)];
      if (picked.every((p) => Math.abs(p - c) >= 4)) picked.push(c);
    }
    goombas = picked;
    break;
  }

  // Events that move Mario vertically.
  const events = [];
  for (let c = 0; c < W; c++) {
    if (weekTotals[c] > 0) {
      const t = tc(c);
      events.push({ t, up: t - 0.24, down: t + 0.24, kps: [{ t, y: HIT_Y, ease: 'ease-in' }] });
    }
  }
  for (const c of goombas) {
    const t = tc(c);
    events.push({
      t, up: t - 0.32, down: t + 0.4,
      kps: [
        { t: t - 0.13, y: -34, ease: 'ease-in' },
        { t, y: -14, ease: 'ease-out' },
        { t: t + 0.16, y: -30, ease: 'ease-in' },
      ],
    });
  }
  const tLast = tc(W - 1);
  const tPipe = tLast + (RPX - cx(W - 1)) / speed;
  const sinkEnd = tPipe + 1.05;
  const T = Math.ceil(((sinkEnd + 1.2) / RESTORE) * 10) / 10;
  events.push({
    t: tPipe, up: tPipe - 0.45, down: Infinity, pipe: true,
    kps: [
      { t: tPipe - 0.2, y: -46, ease: 'ease-in' },
      { t: tPipe, y: -PIPE_H, ease: 'linear' },
      { t: tPipe + 0.3, y: -PIPE_H, ease: 'ease-in' },
      { t: sinkEnd, y: 0, ease: 'linear' },
    ],
  });
  events.sort((a, b) => a.t - b.t);

  // Y keypoints: intro (rise out of left pipe, hop down), then events.
  const ys = [
    { t: 0, y: 0, ease: 'linear' },
    { t: 0.3, y: 0, ease: 'ease-out' },
    { t: 1.0, y: -PIPE_H, ease: 'linear' },
    { t: 1.2, y: -PIPE_H, ease: 'ease-out' },
    { t: 1.45, y: -PIPE_H - 14, ease: 'ease-in' },
    { t: LAND, y: 0, ease: 'linear' },
  ];
  let downEnd = LAND;
  for (const e of events) {
    const last = ys[ys.length - 1];
    if (e.up >= downEnd + 0.01) {
      if (downEnd > last.t + 1e-6) ys.push({ t: downEnd, y: 0, ease: 'linear' });
      ys.push({ t: e.up, y: 0, ease: 'ease-out' });
    } else {
      const first = e.kps[0];
      ys.push({ t: (last.t + first.t) / 2, y: (last.y + first.y) / 2 + 8, ease: 'ease-out' });
    }
    ys.push(...e.kps);
    downEnd = e.down;
  }
  ys.push({ t: T, y: 0, ease: 'linear' });

  const xs = [
    { t: 0, x: LPX }, { t: 1.2, x: LPX }, { t: LAND, x: cx(-1) },
    { t: tLast, x: cx(W - 1) }, { t: tPipe, x: RPX }, { t: T, x: RPX },
  ];

  // Pose: stand in pipes, jump while airborne, run on the ground.
  const poses = [{ t: 0, p: 'st' }];
  const setPose = (t, p) => {
    if (poses[poses.length - 1].p !== p) poses.push({ t, p });
  };
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    let p;
    if (a.t < 1.2 || a.t >= tPipe - 1e-6) p = 'st';
    else p = a.y !== 0 || b.y !== 0 ? 'jp' : 'rn';
    setPose(a.t, p);
  }

  return { W, width, T, cx, tc, xs, ys, poses, goombas, weekTotals, LPX, RPX, tPipe };
}

// --------------------------------------------------------------- render ----

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function render(cal, user, themeName) {
  const th = THEMES[themeName];
  // weeks[c][row] = {count, level} | null
  const weeks = cal.weeks.map((w) => {
    const col = Array(7).fill(null);
    for (const d of w.contributionDays) col[d.weekday] = { count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0 };
    return col;
  });
  const tl = buildTimeline(weeks);
  const { W, width, T, tc } = tl;
  const pc = (t) => r3(Math.min(100, Math.max(0, (t / T) * 100)));
  const kf = (name, frames) => {
    const m = new Map();
    for (const [t, css] of frames) {
      const p = pc(t);
      m.set(p, m.has(p) ? m.get(p) + ';' + css : css);
    }
    return `@keyframes ${name}{${[...m].sort((a, b) => a[0] - b[0]).map(([p, css]) => `${p}%{${css}}`).join('')}}`;
  };
  const tr = (x, y) => `transform:translate(${r3(x)}px,${r3(y)}px)`;
  const TR = T * RESTORE;

  const css = [];
  const grid = [];
  const debris = [];
  const items = [];

  const shared = ['.bk', '.dh', '.dl', '.bp', '.qb', '.cn', '.mu', '.mx', '.my', '.ps', '.gs', '.sc'];
  css.push(`${shared.join(',')}{animation-duration:${T}s;animation-iteration-count:infinite;animation-timing-function:linear;animation-fill-mode:backwards}`);
  css.push(`.dh,.dl,.cn,.mu,.sc{opacity:0}`);
  for (let k = 1; k <= 6; k++) css.push(`.d${k},.d${k} *{animation-delay:${r3(k * ROW_STAGGER)}s}`);
  css.push(`.ps{animation-timing-function:step-end}`);
  css.push(`.fa,.fb{animation:fr .2s step-end infinite}.fb{animation-delay:-.1s}@keyframes fr{0%{opacity:1}50%{opacity:0}}`);
  css.push(`.sp{animation:sp .45s linear infinite;transform-box:fill-box;transform-origin:center}@keyframes sp{50%{transform:scaleX(.15)}}`);
  css.push(`.gs{transform-box:fill-box;transform-origin:50% 100%}`);
  css.push(`.gw{animation:gw .5s step-end infinite;transform-box:fill-box;transform-origin:center}@keyframes gw{50%{transform:scaleX(-1)}}`);
  css.push(`.cl{animation:cl 90s linear infinite}@keyframes cl{from{transform:translateX(${width + 10}px)}to{transform:translateX(-50px)}}`);
  css.push(`.hud{font:bold 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:${th.hud};letter-spacing:.5px}`);
  css.push(`.sc{font:bold 8px ui-monospace,Menlo,Consolas,monospace;fill:#fff;stroke:#000;stroke-width:.4px;paint-order:stroke}`);

  for (let c = 0; c < W; c++) {
    const x = GX + c * PITCH;
    const hit = tl.weekTotals[c] > 0;
    const h = tc(c);
    const kinds = new Set();
    for (let r = 0; r < 7; r++) {
      const d = weeks[c][r];
      if (!d) continue;
      const y = GY + r * PITCH;
      const lv = d.level || (d.count > 0 ? 1 : 0);
      if (lv === 0 || !hit) {
        grid.push(`<use href="#${lv === 0 ? 'e' : lv <= 2 ? 'b' + lv : 'q'}" x="${x}" y="${y}"/>`);
        continue;
      }
      const cls = `c${c}${6 - r ? ' d' + (6 - r) : ''}`;
      if (lv <= 2) {
        kinds.add('b');
        // faint empty slot stays behind so the grid still reads once the brick breaks
        grid.push(`<g class="${cls}" transform="translate(${x} ${y})"><use href="#e"/><use href="#b${lv}" class="bk"/></g>`);
        debris.push(
          `<g class="${cls}" transform="translate(${x} ${y})"><use href="#k" class="dh"/><g transform="translate(0 6)"><use href="#k" class="dl"/></g>` +
            `<g transform="matrix(-1 0 0 1 12 0)"><use href="#k" class="dh"/><g transform="translate(0 6)"><use href="#k" class="dl"/></g></g></g>`,
        );
      } else {
        kinds.add('q');
        grid.push(`<g class="${cls}" transform="translate(${x} ${y})"><g class="bp"><use href="#u"/><use href="#q" class="qb"/></g></g>`);
        if (lv === 3) {
          kinds.add('c');
          items.push(`<g class="${cls}" transform="translate(${x} ${y})"><g class="cn"><use href="#cn" class="sp"/></g></g>`);
        } else {
          kinds.add('m');
          items.push(`<g class="${cls}" transform="translate(${x} ${y})"><use href="#mu" class="mu"/></g>`);
        }
      }
    }
    if (kinds.has('b')) {
      css.push(`.c${c} .bk{animation-name:b${c}}.c${c} .dh{animation-name:h${c}}.c${c} .dl{animation-name:l${c}}`);
      css.push(kf(`b${c}`, [[0, 'opacity:1'], [h, 'opacity:1'], [h + 0.02, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
      for (const [n, dx1, dy1, dx2, dy2] of [['h', -7, -13, -18, 70], ['l', -5, -5, -12, 70]]) {
        css.push(kf(`${n}${c}`, [
          [0, `opacity:0;${tr(0, 0)}`], [h, `opacity:0;${tr(0, 0)}`],
          [h + 0.01, `opacity:1;${tr(0, 0)};animation-timing-function:ease-out`],
          [h + 0.2, `${tr(dx1, dy1)};animation-timing-function:ease-in`],
          [h + 0.75, `opacity:1;${tr(dx2, dy2)}`], [h + 0.77, 'opacity:0'], [T, `opacity:0;${tr(dx2, dy2)}`],
        ]));
      }
    }
    if (kinds.has('q')) {
      css.push(`.c${c} .bp{animation-name:p${c}}.c${c} .qb{animation-name:q${c}}`);
      css.push(kf(`p${c}`, [[0, tr(0, 0)], [h, `${tr(0, 0)};animation-timing-function:ease-out`], [h + 0.07, `${tr(0, -4)};animation-timing-function:ease-in`], [h + 0.14, tr(0, 0)], [T, tr(0, 0)]]));
      css.push(kf(`q${c}`, [[0, 'opacity:1'], [h + 0.1, 'opacity:1'], [h + 0.11, 'opacity:0'], [TR, 'opacity:0'], [T, 'opacity:1']]));
    }
    if (kinds.has('c')) {
      css.push(`.c${c} .cn{animation-name:n${c}}`);
      css.push(kf(`n${c}`, [
        [0, `opacity:0;${tr(0, 0)}`], [h, `opacity:0;${tr(0, 0)}`],
        [h + 0.01, `opacity:1;${tr(0, -4)};animation-timing-function:ease-out`],
        [h + 0.32, `opacity:1;${tr(0, -30)};animation-timing-function:ease-in`],
        [h + 0.55, `opacity:0;${tr(0, -16)}`], [T, `opacity:0;${tr(0, -16)}`],
      ]));
    }
    if (kinds.has('m')) {
      css.push(`.c${c} .mu{animation-name:m${c}}`);
      css.push(kf(`m${c}`, [
        [0, `opacity:0;${tr(0, 0)}`], [h, `opacity:0;${tr(0, 0)}`],
        [h + 0.01, `opacity:1;${tr(0, -1)}`],
        [h + 0.45, `${tr(0, -13)}`],
        [h + 1.15, `opacity:1;${tr(15, -13)}`],
        [h + 1.4, `opacity:0;${tr(19, -13)}`], [T, `opacity:0;${tr(19, -13)}`],
      ]));
    }
  }

  // Goombas
  const goombaSvg = tl.goombas.map((c, i) => {
    const t = tc(c);
    const gx = tl.cx(c);
    css.push(`.gs${i}{animation-name:gs${i}}.sc${i}{animation-name:sc${i}}`);
    css.push(kf(`gs${i}`, [
      [0, 'opacity:1;transform:scaleY(1)'], [t, 'opacity:1;transform:scaleY(1)'],
      [t + 0.03, 'transform:scaleY(.35)'], [t + 0.7, 'opacity:1'], [t + 0.9, 'opacity:0'],
      [TR - 0.01, 'opacity:0;transform:scaleY(.35)'], [TR, 'opacity:0;transform:scaleY(1)'], [T, 'opacity:1;transform:scaleY(1)'],
    ]));
    css.push(kf(`sc${i}`, [
      [0, `opacity:0;${tr(0, 0)}`], [t, `opacity:0;${tr(0, 0)}`], [t + 0.02, `opacity:1;${tr(0, 0)}`],
      [t + 0.7, `opacity:1;${tr(0, -16)}`], [t + 0.9, `opacity:0;${tr(0, -18)}`], [T, 'opacity:0'],
    ]));
    return `<g transform="translate(${gx - 8} ${GROUND - 16})"><g class="gs gs${i}"><use href="#gm" class="gw"/></g></g>` +
      `<text class="sc sc${i}" x="${gx}" y="${GROUND - 24}" text-anchor="middle">100</text>`;
  }).join('');

  // Mario
  css.push(kf('mx', tl.xs.map(({ t, x }) => [t, `transform:translateX(${r3(x)}px)`])));
  css.push(kf('my', tl.ys.map(({ t, y, ease }) => [t, `transform:translateY(${r3(y)}px)${ease !== 'linear' ? ';animation-timing-function:' + ease : ''}`])));
  for (const p of ['st', 'rn', 'jp']) {
    const frames = tl.poses.map(({ t, p: q }) => [t, `opacity:${q === p ? 1 : 0}`]);
    frames.push([T, `opacity:${tl.poses[tl.poses.length - 1].p === p ? 1 : 0}`]);
    css.push(`.${p}{animation-name:${p}}` + kf(p, frames));
  }
  css.push(`.mx{animation-name:mx}.my{animation-name:my}`);
  const mario = `<g transform="translate(0 ${GROUND})"><g class="mx"><g class="my">` +
    `<g class="ps st"><use href="#ms"/></g><g class="ps rn" opacity="0"><use href="#ma" class="fa"/><use href="#mb" class="fb"/></g>` +
    `<g class="ps jp" opacity="0"><use href="#mj"/></g></g></g></g>`;

  // Clouds
  const clouds = [[GRID_BOTTOM + 6, 0], [GRID_BOTTOM + 14, -30], [GY + 30, -55], [GRID_BOTTOM + 2, -75]]
    .map(([y, d]) => `<g transform="translate(0 ${y})"><use href="#cl" class="cl" style="animation-delay:${d}s"/></g>`).join('');

  const pipeTop = GROUND - PIPE_H;
  const pipes = `<use href="#pp" x="${tl.LPX - 13}" y="${pipeTop}"/><use href="#pp" x="${tl.RPX - 13}" y="${pipeTop}"/>`;
  const ground = `<rect y="${GROUND}" width="${width}" height="${GROUND_H}" fill="url(#gt)"/>`;

  const lastDay = cal.weeks.at(-1)?.contributionDays.at(-1)?.date ?? new Date().toISOString();
  const year = lastDay.slice(0, 4);
  const hud = `<g class="hud"><text x="8" y="14">${esc(user.toUpperCase())}</text>` +
    `<text x="${r3(width / 2)}" y="14" text-anchor="middle">COINS ×${cal.totalContributions}</text>` +
    `<text x="${width - 8}" y="14" text-anchor="end">WORLD ${year}</text></g>`;

  const title = `${user}: ${cal.totalContributions} contributions in the last year, as a Super Mario Bros level`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><defs>${defs(th)}</defs><style>${css.join('')}</style>` +
    `<rect width="${width}" height="${HEIGHT}" fill="${th.bg}"/>${clouds}` +
    `<g shape-rendering="crispEdges">${grid.join('')}</g>${goombaSvg}${mario}` +
    `<g shape-rendering="crispEdges">${debris.join('')}</g>${items.join('')}${pipes}${ground}${hud}</svg>\n`;
}

// ------------------------------------------------------------------ cli ----

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' },
      out: { type: 'string', default: 'dist' },
      data: { type: 'string' },
    },
  });
  if (!values.user) {
    console.error('usage: node mario-graph.mjs --user <login> [--out dist] [--data contrib.json]');
    process.exit(2);
  }
  const json = values.data ? JSON.parse(await readFile(values.data, 'utf8')) : await fetchCalendar(values.user);
  const cal = extractCalendar(json);
  await mkdir(values.out, { recursive: true });
  for (const [theme, file] of [['light', 'mario-contribution-graph.svg'], ['dark', 'mario-contribution-graph-dark.svg']]) {
    const svg = render(cal, values.user, theme);
    const path = join(values.out, file);
    await writeFile(path, svg);
    console.log(`wrote ${path} (${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

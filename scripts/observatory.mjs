#!/usr/bin/env node
// Observatory collector: gathers activity stats for every build in the
// CAK3D_Creations catalog and writes data/observatory.json (current snapshot +
// a daily history per app) for observatory.html on the main site.
// Zero dependencies, Node 20+. Runs daily from .github/workflows/observatory.yml.
//
// Sources (each one is skipped cleanly when it isn't available):
//   GitHub repo + release stats   GITHUB_TOKEN (public data, always available in Actions)
//   GitHub traffic (views/clones) OBS_GH_TOKEN  (fine-grained PAT, Administration: read)
//   Vercel Web Analytics          VERCEL_TOKEN + VERCEL_TEAM_ID (analytics enabled per project)
//   Live in-app pings             cak3dcreations.vercel.app/api/activity (public, no secret)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'observatory.json');
const OWNER = 'real-CAK3D';
const HISTORY_DAYS = 365;
const today = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------- catalog ----

// The build list lives in the CAK3D_Creations repo; a new app added there is
// tracked here automatically.
const CATALOG_URL = 'https://raw.githubusercontent.com/real-CAK3D/CAK3D_Creations/main/catalog.js';
const HUB = 'https://cak3dcreations.vercel.app';

async function loadCatalog() {
  const res = await fetch(CATALOG_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const src = await res.text();
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const { PROJECTS, R } = sandbox.window.CAK3D;
  return PROJECTS.map((p) => {
    const repoLink = p.links.find((l) => l.u.startsWith(R) && !/\/releases/.test(l.u)) || p.links.find((l) => l.u.startsWith(R));
    const repo = repoLink ? repoLink.u.slice(R.length).split('/')[0] : null;
    const webLink = p.links.find((l) => /^https:\/\//.test(l.u) && !l.u.startsWith('https://github.com/'));
    const web = webLink ? new URL(webLink.u).host : null;
    return { slug: p.slug, name: p.name, k: p.k, pf: [...p.pf], th: { ...p.th }, repo, web };
  });
}

// -------------------------------------------------------------- github ----

const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const trafficToken = process.env.OBS_GH_TOKEN || '';

async function gh(path, token = ghToken) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cak3d-observatory',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function githubStats(repo) {
  const meta = await gh(`/repos/${OWNER}/${repo}`);
  if (!meta) return null;
  const releases = (await gh(`/repos/${OWNER}/${repo}/releases?per_page=100`)) || [];
  const byRelease = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      date: (r.published_at || r.created_at || '').slice(0, 10),
      downloads: r.assets.reduce((n, a) => n + a.download_count, 0),
    }));
  return {
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    watchers: meta.subscribers_count ?? meta.watchers_count,
    issues: meta.open_issues_count,
    pushedAt: meta.pushed_at,
    downloads: {
      total: byRelease.reduce((n, r) => n + r.downloads, 0),
      latestTag: byRelease[0]?.tag ?? null,
      latestDate: byRelease[0]?.date ?? null,
      byRelease: byRelease.slice(0, 12),
    },
  };
}

// GitHub only keeps 14 days of traffic, so the daily counts are merged into our
// own history every run; that is what lets the dashboard show longer trends.
async function githubTraffic(repo) {
  if (!trafficToken) return null;
  const [views, clones, refs] = await Promise.all([
    gh(`/repos/${OWNER}/${repo}/traffic/views`, trafficToken),
    gh(`/repos/${OWNER}/${repo}/traffic/clones`, trafficToken),
    gh(`/repos/${OWNER}/${repo}/traffic/popular/referrers`, trafficToken),
  ]);
  if (!views) return null;
  const daily = {};
  for (const d of views.views) daily[d.timestamp.slice(0, 10)] = { v: d.count, vu: d.uniques };
  for (const d of clones?.clones || []) Object.assign((daily[d.timestamp.slice(0, 10)] ||= {}), { c: d.count, cu: d.uniques });
  return {
    views14: views.count, viewsUniq14: views.uniques,
    clones14: clones?.count ?? 0, clonesUniq14: clones?.uniques ?? 0,
    referrers: (refs || []).slice(0, 5).map((r) => ({ src: r.referrer, n: r.count })),
    daily,
  };
}

// -------------------------------------------------------------- vercel ----

const vercelToken = process.env.VERCEL_TOKEN || '';
const vercelTeam = process.env.VERCEL_TEAM_ID || '';

// Vercel project names are the *.vercel.app subdomain, minus any "-37"-style suffix.
function vercelProjectFor(host) {
  if (!host || !host.endsWith('.vercel.app')) return null;
  return host.replace(/\.vercel\.app$/, '').replace(/-\d+$/, '');
}

async function vercelVisits(host) {
  const project = vercelProjectFor(host);
  if (!vercelToken || !project) return null;
  const until = new Date();
  const since = new Date(until.getTime() - 30 * 864e5);
  const q = new URLSearchParams({ projectId: project, by: 'day', since: since.toISOString(), until: until.toISOString() });
  if (vercelTeam) q.set('teamId', vercelTeam);
  const res = await fetch(`https://api.vercel.com/v1/query/web-analytics/visits/aggregate?${q}`, {
    headers: { Authorization: `Bearer ${vercelToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    return { enabled: false, reason: body.includes('not_enabled') ? 'analytics-off' : `http-${res.status}` };
  }
  // Sum every numeric pageview/visitor field we can find, whatever the exact row shape.
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.data || json.rows || json.result || [];
  const sum = (keys) => rows.reduce((n, r) => n + (keys.map((k) => r?.[k]).find((x) => typeof x === 'number') || 0), 0);
  return { enabled: true, pageviews30: sum(['pageviews', 'total', 'count', 'visits']), visitors30: sum(['visitors', 'devices', 'uniques']) };
}

// --------------------------------------------------------------- pings ----

// The ping store sits behind the hub's /api/activity (503 until storage is connected).
async function liveUsage() {
  const res = await fetch(`${HUB}/api/activity`);
  if (!res.ok) return null;
  return (await res.json()).apps || {};
}

// ---------------------------------------------------------------- main ----

async function main() {
  const apps = await loadCatalog();
  let prev = { history: {} };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

  const results = [];
  for (const app of apps) {
    const [stats, traffic, web] = await Promise.all([
      app.repo ? githubStats(app.repo).catch((e) => (console.warn(app.repo, e.message), null)) : null,
      app.repo ? githubTraffic(app.repo).catch((e) => (console.warn(app.repo, 'traffic', e.message), null)) : null,
      app.web ? vercelVisits(app.web).catch((e) => (console.warn(app.web, e.message), null)) : null,
    ]);
    results.push({ ...app, github: stats, traffic: traffic && { ...traffic, daily: undefined }, webStats: web, _daily: traffic?.daily });
  }
  const live = await liveUsage().catch(() => null);

  // History: one row per app per day. Snapshots (dl, st) are written for today;
  // traffic (v, vu, c, cu) back-fills every day GitHub still reports.
  const history = prev.history || {};
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  for (const r of results) {
    const h = (history[r.slug] ||= {});
    for (const [day, t] of Object.entries(r._daily || {})) h[day] = { ...h[day], ...t };
    h[today] = {
      ...h[today],
      ...(r.github ? { dl: r.github.downloads.total, st: r.github.stars } : {}),
      ...(r.webStats?.enabled ? { pv30: r.webStats.pageviews30 } : {}),
      ...(live?.[r.slug] ? { dau: live[r.slug].dau } : {}),
    };
    for (const day of Object.keys(h)) if (day < cutoff) delete h[day];
    history[r.slug] = Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
    delete r._daily;
    if (live?.[r.slug]) r.live = live[r.slug];
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sources: {
      github: true,
      traffic: !!trafficToken,
      vercel: !!vercelToken,
      pings: !!live,
    },
    apps: results,
    history,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + '\n');
  const top = [...results].sort((a, b) => (b.github?.downloads.total || 0) - (a.github?.downloads.total || 0)).slice(0, 5);
  console.log(`observatory: ${results.length} apps, sources ${JSON.stringify(out.sources)}`);
  console.log('top downloads:', top.map((a) => `${a.name}=${a.github?.downloads.total ?? 0}`).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });

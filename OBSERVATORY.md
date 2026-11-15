# Observatory

`observatory.html` ranks every build in the
[CAK3D_Creations catalog](https://github.com/real-CAK3D/CAK3D_Creations/blob/main/catalog.js)
by how much it's actually used. The home page shows the top three in its
"Most active right now" strip.

A daily GitHub Action (`.github/workflows/observatory.yml`) runs
`scripts/observatory.mjs`, which writes `data/observatory.json`: a current
snapshot plus a daily history per app. GitHub only keeps 14 days of repo
traffic, so this history is what makes longer trends possible. New builds need
no changes here: once they're in the catalog, they're tracked.

| Source | What it adds | Needs |
|---|---|---|
| GitHub releases | Downloads per release, stars, last push | Nothing (works now) |
| Repo traffic | Repo views and clones per day | `OBS_GH_TOKEN` secret |
| Web analytics | Visits to the Vercel-hosted apps | Web Analytics on + `VERCEL_TOKEN` |
| Live app pings | Daily/weekly/monthly active users, versions in use | Upstash on the hub (see its `OBSERVATORY.md`) |

## Turning sources on

**Repo traffic.** GitHub only shows repo views to accounts with admin access, so
the default Actions token can't read them. Create a fine-grained token at
GitHub → Settings → Developer settings → Fine-grained tokens: resource owner
`real-CAK3D`, all repositories, **Administration: Read-only** (nothing else).
Add it to this repo as the Actions secret `OBS_GH_TOKEN`.

**Web analytics.** In Vercel, open each web project (shelfandstock,
home-inventory, hu-motian, nostalgiavue, cak3d-truck) → Analytics → Enable. Then
create a token at Vercel → Account Settings → Tokens and add it here as the
secret `VERCEL_TOKEN`, plus `VERCEL_TEAM_ID` = `team_h7Xl4dYyZwWCJ4Xf8iP7hRu8`.

**Live app pings.** These are stored behind https://cak3dcreations.vercel.app/api/ping.
Once storage is connected there, the dashboard reads `/api/activity` live and
the daily snapshot records it; this repo needs no secret for it.

Run the collector by hand from the Actions tab (Observatory → Run workflow), or
locally with `GITHUB_TOKEN=... node scripts/observatory.mjs`.

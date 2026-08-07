# VeloPlan Europe — Cloudflare edition

This project is the secure, full-stack version of the bicycle trip planner demo.

## What changed

- Three lunch recommendations and three lodging recommendations for every day.
- A live Google map with pan, zoom, route lines, and color-coded recommendation markers.
- Elevation-profile hover moves a corresponding marker on the map.
- Google Places (New) calls run through the Worker, so the server key is never sent to the browser.
- A separate browser-restricted Maps JavaScript API key is loaded at runtime rather than committed to GitHub.
- Realistic demo recommendations remain visible if Google Places is temporarily unavailable.

## Project layout

- `public/index.html` — browser interface.
- `worker/index.js` — API endpoints and static asset delivery.
- `wrangler.jsonc` — Cloudflare Worker and static asset configuration.
- `scripts/` — validation checks.

## Required Google keys

Use two separate keys:

1. `GOOGLE_MAPS_BROWSER_KEY`
   - Enable **Maps JavaScript API**.
   - Application restriction: **Websites**.
   - Allow `https://planner.dariusteter.net/*` and the temporary `workers.dev` URL during setup.
   - API restriction: **Maps JavaScript API** only.

2. `GOOGLE_PLACES_SERVER_KEY`
   - Use the existing Places key or create a new one.
   - API restriction: **Places API (New)** only.
   - Store it only as an encrypted Cloudflare Worker secret.

Never place either real value in this repository. If a real server key has ever been committed publicly, rotate it in Google Cloud.

## Validate locally

```sh
npm install
npm run check
```

For local map testing, create an ignored `.dev.vars` file:

```text
GOOGLE_MAPS_BROWSER_KEY=your-browser-key
GOOGLE_PLACES_SERVER_KEY=your-server-key
```

Then run:

```sh
npm run dev
```

## Cloudflare deployment settings

- Worker name: `veloplan-europe`
- Repository: `dariusteter/EuroVelo`
- Production branch: `main`
- Root directory: `cloudflare-veloplan`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`
- Custom domain: `planner.dariusteter.net`

Add both required values under **Worker → Settings → Variables and Secrets** and select **Secret** for each.

## API safeguards

The Worker limits searches to Europe, accepts only lunch and lodging searches, caps the radius, returns at most three results, uses a fixed Google field mask, rejects cross-origin browser requests, and never caches Places responses. Add a Cloudflare rate-limiting rule before promoting the prototype beyond a small private test group.

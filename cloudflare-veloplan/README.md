# VeloPlan Europe — Cloudflare edition

This project is the secure, full-stack version of the bicycle trip planner demo.

## What changed

- Three lunch recommendations and three lodging recommendations for every day.
- High-quality Google bicycle routes that follow mapped roads and paths instead of five-point demo lines.
- A live Google map with pan, zoom, detailed route geometry, and color-coded recommendation markers.
- A 256-sample Google elevation profile whose hover position moves along the real route on the map.
- Lodging searches honor the selected camping, hostel, guest-house, and hotel categories.
- Every recommendation card links directly to the place website when available and shows its phone number when Google provides one.
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
   - This is the server-only Google Maps Platform key despite the legacy environment-variable name.
   - Enable **Places API (New)**, **Routes API**, and **Elevation API**.
   - API restriction: those three APIs only.
   - Application restriction: none, because ordinary Workers do not have a fixed outbound IP or browser referrer.
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

The Worker limits searches and daily routes to Europe, accepts only allowlisted lodging preferences, caps search radii, returns at most three results, uses fixed Google field masks, rejects requests without the correct browser origin, and never caches Places responses. The Cloudflare rate-limiting rule should cover both `/api/places` and `/api/route`.

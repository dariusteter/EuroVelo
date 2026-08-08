# Europe Bike Tour Planner — Cloudflare edition

This project is the secure, full-stack version of the bicycle trip planner demo.

## What changed

- Three lunch, lodging, and sightseeing recommendations for every day when enough highly rated results exist.
- Editable start and destination fields use Google’s city-specific autocomplete and show distinct choices when cities share a name.
- A complete OSM bicycle route is divided into daily stages using the selected maximum daily distance.
- Detailed cross-border bicycle routes calculated by openrouteservice from OpenStreetMap data.
- A live Google map with pan, zoom, detailed route geometry, and color-coded recommendation markers.
- A 256-sample route elevation profile whose hover position moves along the real route on the map.
- Exactly one lodging type is selected independently for each day.
- Sightseeing is a separately labeled section for well-reviewed historic, cultural, and natural stops along the route.
- Every recommendation card links directly to the place website when available and shows its phone number when Google provides one.
- Recommendation cards contain their own actions, without a redundant secondary details panel.
- Google Places (New) calls run through the Worker, so the server key is never sent to the browser.
- A separate browser-restricted Maps JavaScript API key is loaded at runtime rather than committed to GitHub.
- Realistic demo recommendations remain visible if Google Places is temporarily unavailable.

## Project layout

- `public/index.html` — browser interface.
- `worker/index.js` — API endpoints and static asset delivery.
- `wrangler.jsonc` — Cloudflare Worker and static asset configuration.
- `scripts/` — validation checks.

## Required API keys

Use two separate keys:

1. `GOOGLE_MAPS_BROWSER_KEY`
   - Enable **Maps JavaScript API**.
   - Application restriction: **Websites**.
   - Allow `https://planner.dariusteter.net/*` and the temporary `workers.dev` URL during setup.
   - API restriction: **Maps JavaScript API** only.

2. `GOOGLE_PLACES_SERVER_KEY`
   - Enable **Places API (New)**.
   - API restriction: **Places API (New)** only.
   - Application restriction: none, because ordinary Workers do not have a fixed outbound IP or browser referrer.
   - Store it only as an encrypted Cloudflare Worker secret.

3. `OPENROUTESERVICE_API_KEY`
   - Create the key in the HeiGIT/openrouteservice account dashboard.
   - Store it only as an encrypted Cloudflare Worker secret.
   - The browser spaces uncached calls two seconds apart, and the Worker caches identical routes for 24 hours to conserve the shared quota.

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
OPENROUTESERVICE_API_KEY=your-heigit-key
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

Add all three required values under **Worker → Settings → Variables and Secrets** and select **Secret** for each.

## API safeguards

The Worker limits searches and routes to Europe, accepts exactly one allowlisted lodging type per day, caps search radii, requires strong sightseeing ratings, uses fixed Google field masks, and rejects requests without the correct browser origin. Recommendation responses are not cached; repeated city lookups and identical OSM routes are cached for 24 hours to conserve provider quotas. The Cloudflare rate-limiting rule covers both `/api/places` and `/api/route`, including city lookup because it uses the protected Places endpoint.

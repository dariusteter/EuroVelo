const GOOGLE_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GOOGLE_ELEVATION_URL = "https://maps.googleapis.com/maps/api/elevation/json";
const MAX_BODY_BYTES = 2048;
const ALLOWED_KINDS = new Set(["lunch", "lodging"]);
const ALLOWED_SURFACE_PREFERENCES = new Set(["bike_paths", "gravel", "quiet_roads"]);
const LODGING_PRIMARY_TYPES = Object.freeze({
  camping: ["campground", "camping_cabin", "rv_park"],
  hostel: ["hostel"],
  guest_house: ["guest_house", "bed_and_breakfast", "inn", "private_guest_room", "farmstay", "cottage"],
  hotel: ["hotel", "motel", "extended_stay_hotel", "resort_hotel"]
});

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.googleMapsUri",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.businessStatus"
].join(",");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config") {
        return handleConfig(request, env);
      }

      if (url.pathname === "/api/places") {
        return await handlePlaces(request, env);
      }

      if (url.pathname === "/api/route") {
        return await handleRoute(request, env);
      }

      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "unknown_error"
      }));
      return json({ error: "The service could not complete this request." }, 500);
    }
  }
};

function handleConfig(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  return json({
    googleMapsBrowserKey: env.GOOGLE_MAPS_BROWSER_KEY || "",
    livePlacesAvailable: Boolean(env.GOOGLE_PLACES_SERVER_KEY),
    liveRoutingAvailable: Boolean(env.GOOGLE_PLACES_SERVER_KEY)
  }, 200, { "Cache-Control": "no-store" });
}

async function handlePlaces(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: apiHeaders() });
  }

  if (request.method !== "POST") {
    return methodNotAllowed("POST, OPTIONS");
  }

  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  if (!env.GOOGLE_PLACES_SERVER_KEY) {
    return json({ error: "Live Places is not configured yet." }, 503);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large." }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const validation = validateSearch(body);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  const { kind, latitude, longitude, radiusMeters, lodgingPreferences } = validation.value;
  const includedPrimaryTypes = kind === "lunch"
    ? ["restaurant", "cafe"]
    : lodgingPreferences.flatMap((preference) => LODGING_PRIMARY_TYPES[preference]);

  const googleResponse = await fetch(GOOGLE_NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_SERVER_KEY,
      "X-Goog-FieldMask": FIELD_MASK
    },
    body: JSON.stringify({
      includedPrimaryTypes,
      maxResultCount: 3,
      rankPreference: "POPULARITY",
      locationRestriction: {
        circle: {
          center: { latitude, longitude },
          radius: radiusMeters
        }
      }
    })
  });

  if (!googleResponse.ok) {
    console.error(JSON.stringify({
      event: "google_places_error",
      status: googleResponse.status,
      kind
    }));
    return json({ error: "Live recommendations are temporarily unavailable." }, 502);
  }

  const data = await googleResponse.json();
  const places = Array.isArray(data.places)
    ? data.places
        .filter((place) => place.businessStatus !== "CLOSED_PERMANENTLY")
        .filter((place) => kind === "lunch" || includedPrimaryTypes.includes(place.primaryType))
        .slice(0, 3)
        .map(normalizePlace)
    : [];

  return json({ places }, 200, { "Cache-Control": "no-store" });
}

async function handleRoute(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: apiHeaders() });
  }

  if (request.method !== "POST") {
    return methodNotAllowed("POST, OPTIONS");
  }

  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  if (!env.GOOGLE_PLACES_SERVER_KEY) {
    return json({ error: "Live routing is not configured yet." }, 503);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large." }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const validation = validateRouteRequest(body);
  if (!validation.ok) {
    return json({ error: validation.error }, 400);
  }

  const { origin, destination } = validation.value;
  const googleResponse = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_SERVER_KEY,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline"
    },
    body: JSON.stringify({
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode: "BICYCLE",
      polylineQuality: "HIGH_QUALITY",
      polylineEncoding: "ENCODED_POLYLINE"
    })
  });

  if (!googleResponse.ok) {
    console.error(JSON.stringify({ event: "google_routes_error", status: googleResponse.status }));
    return json({ error: "The detailed bicycle route is temporarily unavailable." }, 502);
  }

  const data = await googleResponse.json();
  const route = Array.isArray(data.routes) ? data.routes[0] : null;
  const encodedPolyline = String(route?.polyline?.encodedPolyline || "");
  if (!encodedPolyline) {
    return json({ error: "Google did not return a bicycle route for these points." }, 404);
  }

  const elevation = await fetchElevationProfile(encodedPolyline, env.GOOGLE_PLACES_SERVER_KEY);
  return json({
    encodedPolyline,
    distanceMeters: Number(route.distanceMeters || 0),
    durationSeconds: parseDurationSeconds(route.duration),
    elevations: elevation.values,
    ascentMeters: elevation.ascentMeters,
    elevationAvailable: elevation.values.length > 1
  }, 200, { "Cache-Control": "private, max-age=3600" });
}

async function fetchElevationProfile(encodedPolyline, apiKey) {
  const url = new URL(GOOGLE_ELEVATION_URL);
  url.searchParams.set("path", `enc:${encodedPolyline}`);
  url.searchParams.set("samples", "256");
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(JSON.stringify({ event: "google_elevation_error", status: response.status }));
      return { values: [], ascentMeters: 0 };
    }
    const data = await response.json();
    if (data.status !== "OK" || !Array.isArray(data.results)) {
      console.error(JSON.stringify({ event: "google_elevation_status", status: String(data.status || "UNKNOWN") }));
      return { values: [], ascentMeters: 0 };
    }
    const values = data.results.map((result) => Number(result.elevation)).filter(Number.isFinite);
    return { values, ascentMeters: calculateAscent(values) };
  } catch (error) {
    console.error(JSON.stringify({
      event: "google_elevation_request_failed",
      error: error instanceof Error ? error.message : "unknown_error"
    }));
    return { values: [], ascentMeters: 0 };
  }
}

function validateRouteRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be an object." };
  }
  const origin = validateEuropePoint(input.origin);
  const destination = validateEuropePoint(input.destination);
  if (!origin || !destination) {
    return { ok: false, error: "Origin and destination must be valid locations in Europe." };
  }
  const surfacePreference = String(input.surfacePreference || "bike_paths");
  if (!ALLOWED_SURFACE_PREFERENCES.has(surfacePreference)) {
    return { ok: false, error: "The surface preference is invalid." };
  }
  if (haversineMeters(origin, destination) > 300000) {
    return { ok: false, error: "A single daily route cannot exceed 300 km." };
  }
  return { ok: true, value: { origin, destination, surfacePreference } };
}

function validateEuropePoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || latitude < 34 || latitude > 72) return null;
  if (!Number.isFinite(longitude) || longitude < -25 || longitude > 45) return null;
  return { latitude, longitude };
}

function parseDurationSeconds(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(Number(match[1])) : 0;
}

function calculateAscent(values) {
  let ascent = 0;
  for (let index = 1; index < values.length; index += 1) {
    const gain = values[index] - values[index - 1];
    if (gain > 1) ascent += gain;
  }
  return Math.round(ascent);
}

function haversineMeters(pointA, pointB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(pointA.latitude);
  const lat2 = radians(pointB.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(pointB.longitude - pointA.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateSearch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be an object." };
  }

  const kind = String(input.kind || "");
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const requestedRadius = Number(input.radiusMeters || 5000);
  const lodgingPreferences = Array.isArray(input.lodgingPreferences)
    ? [...new Set(input.lodgingPreferences.map(String))]
    : [];

  if (!ALLOWED_KINDS.has(kind)) {
    return { ok: false, error: "kind must be lunch or lodging." };
  }
  if (!Number.isFinite(latitude) || latitude < 34 || latitude > 72) {
    return { ok: false, error: "latitude must be within Europe." };
  }
  if (!Number.isFinite(longitude) || longitude < -25 || longitude > 45) {
    return { ok: false, error: "longitude must be within Europe." };
  }
  if (!Number.isFinite(requestedRadius)) {
    return { ok: false, error: "radiusMeters must be numeric." };
  }
  if (kind === "lodging") {
    if (!lodgingPreferences.length || lodgingPreferences.length > Object.keys(LODGING_PRIMARY_TYPES).length) {
      return { ok: false, error: "Select between one and four lodging preferences." };
    }
    if (lodgingPreferences.some((preference) => !LODGING_PRIMARY_TYPES[preference])) {
      return { ok: false, error: "One or more lodging preferences are invalid." };
    }
  }

  return {
    ok: true,
    value: {
      kind,
      latitude,
      longitude,
      radiusMeters: Math.min(10000, Math.max(500, Math.round(requestedRadius))),
      lodgingPreferences
    }
  };
}

function normalizePlace(place) {
  return {
    id: String(place.id || ""),
    name: String(place.displayName?.text || "Unnamed place"),
    address: String(place.formattedAddress || ""),
    latitude: Number(place.location?.latitude),
    longitude: Number(place.location?.longitude),
    rating: Number(place.rating || 0),
    userRatingCount: Number(place.userRatingCount || 0),
    websiteUri: safeUrl(place.websiteUri),
    phone: String(place.internationalPhoneNumber || place.nationalPhoneNumber || ""),
    googleMapsUri: safeUrl(place.googleMapsUri),
    primaryType: String(place.primaryType || ""),
    type: String(place.primaryTypeDisplayName?.text || "Place")
  };
}

function safeUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function sameOriginRequest(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin) && origin === new URL(request.url).origin;
}

function methodNotAllowed(allow) {
  return json({ error: "Method not allowed." }, 405, { Allow: allow });
}

function apiHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra
  };
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: apiHeaders(extraHeaders)
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

const GOOGLE_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const MAX_BODY_BYTES = 2048;
const ALLOWED_KINDS = new Set(["lunch", "lodging"]);

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
    livePlacesAvailable: Boolean(env.GOOGLE_PLACES_SERVER_KEY)
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

  const { kind, latitude, longitude, radiusMeters } = validation.value;
  const includedPrimaryTypes = kind === "lunch"
    ? ["restaurant", "cafe"]
    : ["hotel", "hostel", "bed_and_breakfast", "guest_house", "campground"];

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
        .slice(0, 3)
        .map(normalizePlace)
    : [];

  return json({ places }, 200, { "Cache-Control": "no-store" });
}

function validateSearch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be an object." };
  }

  const kind = String(input.kind || "");
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const requestedRadius = Number(input.radiusMeters || 5000);

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

  return {
    ok: true,
    value: {
      kind,
      latitude,
      longitude,
      radiusMeters: Math.min(10000, Math.max(500, Math.round(requestedRadius)))
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
  if (!origin) return true;
  return origin === new URL(request.url).origin;
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

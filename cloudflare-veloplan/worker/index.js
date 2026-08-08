const GOOGLE_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const OPENROUTESERVICE_DIRECTIONS_URL = "https://api.heigit.org/openrouteservice/v2/directions";
const MAX_BODY_BYTES = 2048;
const ALLOWED_KINDS = new Set(["lunch", "lodging", "attraction", "city"]);
const ALLOWED_SURFACE_PREFERENCES = new Set(["bike_paths", "gravel", "quiet_roads"]);
const LODGING_PRIMARY_TYPES = Object.freeze({
  camping: ["campground", "camping_cabin", "rv_park"],
  hostel: ["hostel"],
  guest_house: ["guest_house", "bed_and_breakfast", "inn", "private_guest_room", "farmstay", "cottage"],
  hotel: ["hotel", "motel", "extended_stay_hotel", "resort_hotel"]
});
const ATTRACTION_PRIMARY_TYPES = Object.freeze([
  "art_museum", "botanical_garden", "castle", "cultural_landmark", "historical_landmark",
  "historical_place", "history_museum", "monument", "museum", "national_park",
  "nature_preserve", "observation_deck", "scenic_spot", "state_park", "tourist_attraction",
  "wildlife_refuge"
]);
const ROUTING_PROFILES = Object.freeze({
  bike_paths: "cycling-regular",
  gravel: "cycling-mountain",
  quiet_roads: "cycling-road"
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config") {
        return handleConfig(request, env);
      }

      if (url.pathname === "/api/places") {
        return await handlePlaces(request, env, ctx);
      }

      if (url.pathname === "/api/route") {
        return await handleRoute(request, env, ctx);
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
    liveRoutingAvailable: Boolean(env.OPENROUTESERVICE_API_KEY)
  }, 200, { "Cache-Control": "no-store" });
}

async function handlePlaces(request, env, ctx) {
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

  const { kind, latitude, longitude, radiusMeters, lodgingPreference, attractionAnchors, query } = validation.value;
  if (kind === "city") {
    return await handleCitySearch(request, env, ctx, query);
  }
  const includedPrimaryTypes = kind === "lunch"
    ? ["restaurant", "cafe"]
    : kind === "lodging"
      ? LODGING_PRIMARY_TYPES[lodgingPreference]
      : ATTRACTION_PRIMARY_TYPES;

  const searchCenters = kind === "attraction" ? attractionAnchors : [{ latitude, longitude }];
  const googleResponses = await Promise.all(searchCenters.map((center) => fetch(GOOGLE_NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_SERVER_KEY,
      "X-Goog-FieldMask": FIELD_MASK
    },
    body: JSON.stringify({
      includedPrimaryTypes,
      maxResultCount: kind === "attraction" ? 10 : 3,
      rankPreference: "POPULARITY",
      locationRestriction: {
        circle: {
          center,
          radius: radiusMeters
        }
      }
    })
  })));

  const failedResponse = googleResponses.find((response) => !response.ok);
  if (failedResponse) {
    console.error(JSON.stringify({
      event: "google_places_error",
      status: failedResponse.status,
      kind
    }));
    return json({ error: "Live recommendations are temporarily unavailable." }, 502);
  }

  const data = await Promise.all(googleResponses.map((response) => response.json()));
  const uniquePlaces = new Map();
  data.flatMap((result) => Array.isArray(result.places) ? result.places : [])
    .forEach((place) => uniquePlaces.set(String(place.id || place.displayName?.text || ""), place));
  const places = [...uniquePlaces.values()]
        .filter((place) => place.businessStatus !== "CLOSED_PERMANENTLY")
        .filter((place) => kind === "lunch" || includedPrimaryTypes.includes(place.primaryType))
        .filter((place) => kind !== "attraction" || (Number(place.rating) >= 4.4 && Number(place.userRatingCount) >= 50))
        .sort((left, right) => kind === "attraction" ? attractionScore(right) - attractionScore(left) : 0)
        .slice(0, 3)
        .map(normalizePlace);

  return json({ places }, 200, { "Cache-Control": "no-store" });
}

async function handleCitySearch(request, env, ctx, query) {
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheUrl = new URL("/__city-cache", request.url);
  cacheUrl.searchParams.set("q", query.toLocaleLowerCase("en"));
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cachedResponse = cache ? await cache.match(cacheKey) : null;
  if (cachedResponse) {
    return cloneWithHeaders(cachedResponse, {
      "Cache-Control": "private, max-age=300",
      "X-City-Cache": "HIT"
    });
  }

  const googleResponse = await fetch(GOOGLE_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_SERVER_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
    },
    body: JSON.stringify({
      textQuery: query,
      includedType: "locality",
      strictTypeFiltering: true,
      pageSize: 10,
      languageCode: "en",
      locationRestriction: {
        rectangle: {
          low: { latitude: 34, longitude: -25 },
          high: { latitude: 72, longitude: 45 }
        }
      }
    })
  });

  if (!googleResponse.ok) {
    console.error(JSON.stringify({
      event: "google_city_search_error",
      status: googleResponse.status
    }));
    return json({ error: "City suggestions are temporarily unavailable." }, 502);
  }

  const data = await googleResponse.json();
  const cities = (Array.isArray(data.places) ? data.places : [])
    .filter((place) => validateEuropePoint(place.location))
    .slice(0, 10)
    .map((place) => ({
      id: String(place.id || ""),
      name: String(place.displayName?.text || place.formattedAddress || "Unknown city"),
      label: String(place.formattedAddress || place.displayName?.text || "Unknown city"),
      latitude: Number(place.location.latitude),
      longitude: Number(place.location.longitude)
    }));
  const payload = { cities };
  const response = json(payload, 200, {
    "Cache-Control": "private, max-age=300",
    "X-City-Cache": "MISS"
  });
  if (cache) {
    const cacheWrite = cache.put(cacheKey, json(payload, 200, {
      "Cache-Control": "public, max-age=86400"
    }));
    if (ctx) ctx.waitUntil(cacheWrite);
    else await cacheWrite;
  }
  return response;
}

async function handleRoute(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: apiHeaders() });
  }

  if (request.method !== "POST") {
    return methodNotAllowed("POST, OPTIONS");
  }

  if (!sameOriginRequest(request)) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }

  if (!env.OPENROUTESERVICE_API_KEY) {
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

  const { origin, destination, surfacePreference } = validation.value;
  const profile = ROUTING_PROFILES[surfacePreference];
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = routeCacheKey(request, origin, destination, profile);
  const cachedResponse = cache ? await cache.match(cacheKey) : null;
  if (cachedResponse) {
    return cloneWithHeaders(cachedResponse, {
      "Cache-Control": "private, max-age=3600",
      "X-Route-Cache": "HIT"
    });
  }
  const routingResponse = await fetch(`${OPENROUTESERVICE_DIRECTIONS_URL}/${profile}/geojson`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": env.OPENROUTESERVICE_API_KEY
    },
    body: JSON.stringify({
      coordinates: [
        [origin.longitude, origin.latitude],
        [destination.longitude, destination.latitude]
      ],
      preference: "recommended",
      elevation: true,
      instructions: false,
      geometry_simplify: false
    })
  });

  if (!routingResponse.ok) {
    console.error(JSON.stringify({
      event: "openrouteservice_error",
      status: routingResponse.status,
      profile
    }));
    if (routingResponse.status === 429) {
      const retryAfter = boundedRetryAfter(routingResponse.headers.get("Retry-After"));
      return json({ error: "The bicycle routing service is busy. Please try again shortly." }, 429, {
        "Retry-After": String(retryAfter)
      });
    }
    return json({ error: "The detailed bicycle route is temporarily unavailable." }, 502);
  }

  const data = await routingResponse.json();
  const feature = Array.isArray(data.features) ? data.features[0] : null;
  const coordinates = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates.filter(isRouteCoordinate)
    : [];
  if (coordinates.length < 2) {
    return json({ error: "OpenRouteService did not return a bicycle route for these points." }, 404);
  }

  const summary = feature?.properties?.summary || {};
  const elevations = sampleRouteElevations(coordinates, 256);
  const fullElevations = coordinates.map((coordinate) => Number(coordinate[2])).filter(Number.isFinite);
  const payload = {
    route: coordinates.map((coordinate) => [
      Number(coordinate[1]),
      Number(coordinate[0]),
      Number.isFinite(Number(coordinate[2])) ? Number(coordinate[2]) : null
    ]),
    distanceMeters: Number(summary.distance || 0),
    durationSeconds: Math.round(Number(summary.duration || 0)),
    elevations,
    ascentMeters: Math.round(Number(feature?.properties?.ascent || calculateAscent(fullElevations))),
    elevationAvailable: elevations.length > 1,
    routeProvider: "OpenStreetMap / openrouteservice"
  };
  const response = json(payload, 200, {
    "Cache-Control": "private, max-age=3600",
    "X-Route-Cache": "MISS"
  });
  if (cache) {
    const cacheWrite = cache.put(cacheKey, json(payload, 200, {
      "Cache-Control": "public, max-age=86400"
    }));
    if (ctx) ctx.waitUntil(cacheWrite);
    else await cacheWrite;
  }
  return response;
}

function routeCacheKey(request, origin, destination, profile) {
  const url = new URL("/__route-cache", request.url);
  url.searchParams.set("origin", `${origin.latitude.toFixed(5)},${origin.longitude.toFixed(5)}`);
  url.searchParams.set("destination", `${destination.latitude.toFixed(5)},${destination.longitude.toFixed(5)}`);
  url.searchParams.set("profile", profile);
  return new Request(url, { method: "GET" });
}

function cloneWithHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function boundedRetryAfter(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(120, Math.max(2, Math.ceil(seconds))) : 10;
}

function isRouteCoordinate(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]));
}

function sampleRouteElevations(coordinates, sampleCount) {
  const elevated = coordinates.filter((coordinate) => Number.isFinite(Number(coordinate[2])));
  if (elevated.length < 2) return [];
  const cumulative = [0];
  for (let index = 1; index < elevated.length; index += 1) {
    cumulative.push(cumulative[index - 1] + coordinateDistanceMeters(elevated[index - 1], elevated[index]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!total) return elevated.slice(0, sampleCount).map((coordinate) => Number(coordinate[2]));
  const values = [];
  let high = 1;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const target = total * sample / (sampleCount - 1);
    while (high < cumulative.length - 1 && cumulative[high] < target) high += 1;
    const low = Math.max(0, high - 1);
    const span = cumulative[high] - cumulative[low] || 1;
    const fraction = (target - cumulative[low]) / span;
    const elevation = Number(elevated[low][2]) + (Number(elevated[high][2]) - Number(elevated[low][2])) * fraction;
    values.push(Math.round(elevation * 10) / 10);
  }
  return values;
}

function coordinateDistanceMeters(left, right) {
  return haversineMeters(
    { latitude: Number(left[1]), longitude: Number(left[0]) },
    { latitude: Number(right[1]), longitude: Number(right[0]) }
  );
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
  const tripPlan = input.tripPlan === true;
  if (!ALLOWED_SURFACE_PREFERENCES.has(surfacePreference)) {
    return { ok: false, error: "The surface preference is invalid." };
  }
  const maximumDistance = tripPlan ? 6000000 : 300000;
  if (haversineMeters(origin, destination) > maximumDistance) {
    return { ok: false, error: tripPlan
      ? "This trip exceeds the 6,000 km routing limit."
      : "A single daily route cannot exceed 300 km." };
  }
  return { ok: true, value: { origin, destination, surfacePreference, tripPlan } };
}

function validateEuropePoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || latitude < 34 || latitude > 72) return null;
  if (!Number.isFinite(longitude) || longitude < -25 || longitude > 45) return null;
  return { latitude, longitude };
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
  const query = String(input.query || "").trim();
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const requestedRadius = Number(input.radiusMeters || 5000);
  const lodgingPreference = String(input.lodgingPreference || "");
  const rawAttractionAnchors = kind === "attraction" && Array.isArray(input.attractionAnchors)
    ? input.attractionAnchors
    : [];
  const attractionAnchors = rawAttractionAnchors.length
    ? rawAttractionAnchors.map(validateEuropePoint)
    : [{ latitude, longitude }];

  if (!ALLOWED_KINDS.has(kind)) {
    return { ok: false, error: "kind must be lunch, lodging, attraction, or city." };
  }
  if (kind === "city") {
    if (query.length < 2 || query.length > 80) {
      return { ok: false, error: "City searches must contain between 2 and 80 characters." };
    }
    return { ok: true, value: { kind, query } };
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
    if (!LODGING_PRIMARY_TYPES[lodgingPreference]) {
      return { ok: false, error: "Select exactly one valid lodging preference." };
    }
  }
  if (kind === "attraction" && (
    !attractionAnchors.length
    || attractionAnchors.length > 3
    || attractionAnchors.some((anchor) => !anchor)
  )) {
    return { ok: false, error: "Sightseeing searches require between one and three route anchors." };
  }

  return {
    ok: true,
    value: {
      kind,
      latitude,
      longitude,
      radiusMeters: Math.min(10000, Math.max(500, Math.round(requestedRadius))),
      lodgingPreference,
      attractionAnchors
    }
  };
}

function attractionScore(place) {
  return Number(place.rating || 0) * Math.log10(Number(place.userRatingCount || 0) + 10);
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

import worker from "../worker/index.js";

const env = {
  GOOGLE_MAPS_BROWSER_KEY: "browser-test-key",
  GOOGLE_PLACES_SERVER_KEY: "server-test-key",
  ASSETS: {
    fetch: async () => new Response("asset", { headers: { "Content-Type": "text/plain" } })
  }
};

const configResponse = await worker.fetch(new Request("https://planner.example.test/api/config"), env);
const config = await configResponse.json();
assert(configResponse.status === 200, "config endpoint should return 200");
assert(config.googleMapsBrowserKey === "browser-test-key", "config endpoint should return the browser key");
assert(config.liveRoutingAvailable === true, "config endpoint should advertise live routing");

const crossOriginResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "https://attacker.example" },
  body: JSON.stringify({ kind: "lunch", latitude: 48.2, longitude: 16.4 })
}), env);
assert(crossOriginResponse.status === 403, "cross-origin Places requests should be rejected");

const missingOriginResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "lunch", latitude: 48.2, longitude: 16.4 })
}), env);
assert(missingOriginResponse.status === 403, "Places requests without a browser origin should be rejected");

const invalidResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
  body: JSON.stringify({ kind: "shopping", latitude: 48.2, longitude: 16.4 })
}), env);
assert(invalidResponse.status === 400, "invalid Places search kinds should be rejected");

const originalFetch = globalThis.fetch;
let lodgingRequestBody;
let routeRequestBody;
let elevationRequestUrl;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes("places.googleapis.com")) {
    lodgingRequestBody = JSON.parse(init.body);
    return Response.json({
      places: [
        googlePlace("Hostel One", "hostel", "+421 2 555 0101", "https://hostel.example"),
        googlePlace("Guest Rooms", "guest_house", "+421 2 555 0102", "https://guest.example"),
        googlePlace("Fancy Hotel", "hotel", "+421 2 555 0103", "https://hotel.example")
      ]
    });
  }
  if (url.includes("routes.googleapis.com")) {
    routeRequestBody = JSON.parse(init.body);
    return Response.json({ routes: [{
      distanceMeters: 68400,
      duration: "15000s",
      polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }
    }] });
  }
  if (url.includes("maps.googleapis.com/maps/api/elevation")) {
    elevationRequestUrl = new URL(url);
    return Response.json({
      status: "OK",
      results: [{ elevation: 100 }, { elevation: 106 }, { elevation: 103 }, { elevation: 115 }]
    });
  }
  throw new Error(`Unexpected outbound request: ${url}`);
};

try {
  const lodgingResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({
      kind: "lodging",
      latitude: 48.2,
      longitude: 16.4,
      lodgingPreferences: ["hostel", "guest_house"]
    })
  }), env);
  const lodgingData = await lodgingResponse.json();
  assert(lodgingResponse.status === 200, "preference-filtered lodging search should return 200");
  assert(!lodgingRequestBody.includedPrimaryTypes.includes("hotel"), "unchecked hotels must not be requested");
  assert(lodgingData.places.length === 2, "unexpected hotel results must be removed");
  assert(lodgingData.places[0].websiteUri === "https://hostel.example/", "website should be returned");
  assert(lodgingData.places[0].phone === "+421 2 555 0101", "phone number should be returned");

  const routeResponse = await worker.fetch(new Request("https://planner.example.test/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({
      origin: { latitude: 48.2082, longitude: 16.3738 },
      destination: { latitude: 48.1486, longitude: 17.1077 },
      surfacePreference: "bike_paths"
    })
  }), env);
  const routeData = await routeResponse.json();
  assert(routeResponse.status === 200, "detailed bicycle route should return 200");
  assert(routeData.encodedPolyline.length > 10, "route should include an encoded polyline");
  assert(routeData.distanceMeters === 68400, "route should include Google distance");
  assert(routeData.elevations.length === 4, "route should include a dense-ready elevation array");
  assert(routeData.ascentMeters === 18, "route should calculate cumulative ascent");
  assert(routeRequestBody.travelMode === "BICYCLE", "route should use bicycle travel mode");
  assert(routeRequestBody.polylineQuality === "HIGH_QUALITY", "route should request high-quality geometry");
  assert(elevationRequestUrl.searchParams.get("samples") === "256", "elevation should request 256 samples");
} finally {
  globalThis.fetch = originalFetch;
}

const assetResponse = await worker.fetch(new Request("https://planner.example.test/"), env);
assert(assetResponse.headers.get("X-Content-Type-Options") === "nosniff", "asset responses should include security headers");
assert(assetResponse.headers.get("Referrer-Policy") === "strict-origin-when-cross-origin", "asset responses should preserve an origin referrer for Maps key restrictions");

console.log("Worker routes OK: config, origin guard, preference filtering, detailed route, elevation, assets");

function googlePlace(name, primaryType, phone, websiteUri) {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    displayName: { text: name },
    formattedAddress: "Test address",
    location: { latitude: 48.2, longitude: 16.4 },
    rating: 4.7,
    userRatingCount: 321,
    websiteUri,
    internationalPhoneNumber: phone,
    googleMapsUri: "https://maps.google.com/",
    primaryType,
    primaryTypeDisplayName: { text: primaryType },
    businessStatus: "OPERATIONAL"
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

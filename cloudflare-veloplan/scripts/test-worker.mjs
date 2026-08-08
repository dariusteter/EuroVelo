import worker from "../worker/index.js";

const env = {
  GOOGLE_MAPS_BROWSER_KEY: "browser-test-key",
  GOOGLE_PLACES_SERVER_KEY: "server-test-key",
  OPENROUTESERVICE_API_KEY: "heigit-test-key",
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
const placesRequestBodies = [];
let citySearchRequestBody;
let cityDetailsUrl;
let routeRequestBody;
let routeAuthorization;
let reverseGeocodeUrl;
let reverseGeocodeAuthorization;
let routeRateLimited = false;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes("places.googleapis.com/v1/places:autocomplete")) {
    citySearchRequestBody = JSON.parse(init.body);
    return Response.json({ suggestions: [
      googleCityPrediction("city-vienna-austria", "Vienna", "Vienna, Austria"),
      googleCityPrediction("city-vienne-france", "Vienne", "Vienne, France"),
      googleCityPrediction("city-vienna-georgia", "Vienna", "Vienna, Georgia, USA")
    ] });
  }
  if (url.includes("places.googleapis.com/v1/places/city-vienna-austria")) {
    cityDetailsUrl = url;
    return Response.json({
      id: "city-vienna-austria",
      displayName: { text: "Vienna" },
      formattedAddress: "Vienna, Austria",
      location: { latitude: 48.2082, longitude: 16.3738 }
    });
  }
  if (url.includes("places.googleapis.com/v1/places:searchNearby")) {
    const requestBody = JSON.parse(init.body);
    placesRequestBodies.push(requestBody);
    if (requestBody.includedPrimaryTypes.includes("tourist_attraction")) {
      return Response.json({ places: [
        googlePlace("Castle View", "castle", "+421 2 555 0201", "https://castle.example", 4.8, 1400),
        googlePlace("Quiet Monument", "monument", "+421 2 555 0202", "https://monument.example", 4.5, 220),
        googlePlace("Unrated Stop", "historical_place", "", "", 4.1, 12)
      ] });
    }
    return Response.json({
      places: [
        googlePlace("Hostel One", "hostel", "+421 2 555 0101", "https://hostel.example"),
        googlePlace("Guest Rooms", "guest_house", "+421 2 555 0102", "https://guest.example"),
        googlePlace("Fancy Hotel", "hotel", "+421 2 555 0103", "https://hotel.example")
      ]
    });
  }
  if (url.includes("api.heigit.org/pelias/v1/reverse")) {
    reverseGeocodeUrl = url;
    reverseGeocodeAuthorization = new Headers(init.headers).get("Authorization");
    return Response.json({
      features: [{
        properties: {
          name: "Test Street",
          layer: "street",
          locality: "Ansbach",
          county: "Ansbach"
        }
      }]
    });
  }
  if (url.includes("api.heigit.org/openrouteservice")) {
    if (routeRateLimited) {
      return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "7" } });
    }
    routeRequestBody = JSON.parse(init.body);
    routeAuthorization = new Headers(init.headers).get("Authorization");
    return Response.json({
      features: [{
        geometry: { coordinates: [
          [16.3738, 48.2082, 100],
          [16.6, 48.18, 106],
          [16.85, 48.16, 103],
          [17.1077, 48.1486, 115]
        ] },
        properties: { summary: { distance: 68400, duration: 15000 }, ascent: 18 }
      }]
    });
  }
  throw new Error(`Unexpected outbound request: ${url}`);
};

try {
  const cityResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({ kind: "city", query: "Vienna", sessionToken: "city-session-1234" })
  }), env);
  const cityData = await cityResponse.json();
  assert(cityResponse.status === 200, "city lookup should return 200");
  assert(citySearchRequestBody.includedPrimaryTypes.length === 1 && citySearchRequestBody.includedPrimaryTypes[0] === "(cities)", "city lookup should use Google's city collection");
  assert(citySearchRequestBody.locationRestriction.rectangle.low.latitude === 34, "city lookup should be restricted to Europe");
  assert(citySearchRequestBody.sessionToken === "city-session-1234", "city lookup should preserve its billing session token");
  assert(cityData.cities.length === 3, "ambiguous city names should return distinct choices");
  assert(cityData.cities[0].label === "Vienna, Austria", "city choices should include an unambiguous label");

  const cityDetailsResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({ kind: "city_details", placeId: "city-vienna-austria", sessionToken: "city-session-1234" })
  }), env);
  const cityDetailsData = await cityDetailsResponse.json();
  assert(cityDetailsResponse.status === 200, "selected city details should return 200");
  assert(cityDetailsUrl.includes("sessionToken=city-session-1234"), "city detail lookup should complete the autocomplete session");
  assert(cityDetailsData.city.latitude === 48.2082, "selected city should include routing coordinates");

  const lodgingResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({
      kind: "lodging",
      latitude: 48.2,
      longitude: 16.4,
      lodgingPreference: "hostel"
    })
  }), env);
  const lodgingData = await lodgingResponse.json();
  assert(lodgingResponse.status === 200, "preference-filtered lodging search should return 200");
  const lodgingRequestBody = placesRequestBodies[0];
  assert(lodgingRequestBody.includedPrimaryTypes.length === 1 && lodgingRequestBody.includedPrimaryTypes[0] === "hostel", "exactly one lodging type should be requested");
  assert(lodgingData.places.length === 1, "non-hostel results must be removed");
  assert(lodgingData.places[0].websiteUri === "https://hostel.example/", "website should be returned");
  assert(lodgingData.places[0].phone === "+421 2 555 0101", "phone number should be returned");

  const attractionResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({ kind: "attraction", latitude: 48.2, longitude: 16.4, radiusMeters: 7000 })
  }), env);
  const attractionData = await attractionResponse.json();
  assert(attractionResponse.status === 200, "sightseeing search should return 200");
  assert(attractionData.places.length === 2, "poorly rated sightseeing should be excluded");
  assert(attractionData.places[0].name === "Castle View", "sightseeing should favor highly regarded places");

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
  assert(routeData.route.length === 4, "route should include detailed OSM geometry");
  assert(routeData.distanceMeters === 68400, "route should include OpenRouteService distance");
  assert(routeData.elevations.length === 256, "route should include a 256-sample elevation array");
  assert(routeData.ascentMeters === 18, "route should include cumulative ascent");
  assert(routeRequestBody.elevation === true, "route should request elevation");
  assert(routeRequestBody.geometry_simplify === false, "route should preserve detailed geometry");
  assert(routeAuthorization === "heigit-test-key", "route key should stay in the Worker authorization header");
  assert(routeData.routeProvider.includes("OpenStreetMap"), "route should identify its OSM data source");

  const stopNameResponse = await worker.fetch(new Request("https://planner.example.test/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({
      action: "reverse_geocode",
      point: { latitude: 49.3, longitude: 10.57 }
    })
  }), env);
  const stopNameData = await stopNameResponse.json();
  assert(stopNameResponse.status === 200, "overnight town lookup should return 200");
  assert(stopNameData.name === "Ansbach", "overnight waypoint should use the nearest locality rather than a street");
  assert(reverseGeocodeUrl.includes("point.lat=49.3") && reverseGeocodeUrl.includes("point.lon=10.57"), "reverse geocoder should receive the waypoint coordinates");
  assert(reverseGeocodeAuthorization === "heigit-test-key", "reverse geocoder key should stay in the Worker authorization header");

  routeRateLimited = true;
  const limitedRouteResponse = await worker.fetch(new Request("https://planner.example.test/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
    body: JSON.stringify({
      origin: { latitude: 48.2082, longitude: 16.3738 },
      destination: { latitude: 48.2, longitude: 16.9 },
      surfacePreference: "gravel"
    })
  }), env);
  assert(limitedRouteResponse.status === 429, "routing quota responses should remain 429");
  assert(limitedRouteResponse.headers.get("Retry-After") === "7", "routing quota response should preserve a bounded retry delay");
  routeRateLimited = false;
} finally {
  globalThis.fetch = originalFetch;
}

const assetResponse = await worker.fetch(new Request("https://planner.example.test/"), env);
assert(assetResponse.headers.get("X-Content-Type-Options") === "nosniff", "asset responses should include security headers");
assert(assetResponse.headers.get("Referrer-Policy") === "strict-origin-when-cross-origin", "asset responses should preserve an origin referrer for Maps key restrictions");

console.log("Worker routes OK: config, origin guard, preference filtering, detailed route, elevation, overnight names, assets");

function googlePlace(name, primaryType, phone, websiteUri, rating = 4.7, userRatingCount = 321) {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    displayName: { text: name },
    formattedAddress: "Test address",
    location: { latitude: 48.2, longitude: 16.4 },
    rating,
    userRatingCount,
    websiteUri,
    internationalPhoneNumber: phone,
    googleMapsUri: "https://maps.google.com/",
    primaryType,
    primaryTypeDisplayName: { text: primaryType },
    businessStatus: "OPERATIONAL"
  };
}

function googleCityPrediction(placeId, name, label) {
  return {
    placePrediction: {
      placeId,
      text: { text: label },
      structuredFormat: {
        mainText: { text: name },
        secondaryText: { text: label.replace(`${name}, `, "") }
      }
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

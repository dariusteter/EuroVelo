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

const crossOriginResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "https://attacker.example" },
  body: JSON.stringify({ kind: "lunch", latitude: 48.2, longitude: 16.4 })
}), env);
assert(crossOriginResponse.status === 403, "cross-origin Places requests should be rejected");

const invalidResponse = await worker.fetch(new Request("https://planner.example.test/api/places", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "https://planner.example.test" },
  body: JSON.stringify({ kind: "shopping", latitude: 48.2, longitude: 16.4 })
}), env);
assert(invalidResponse.status === 400, "invalid Places search kinds should be rejected");

const assetResponse = await worker.fetch(new Request("https://planner.example.test/"), env);
assert(assetResponse.headers.get("X-Content-Type-Options") === "nosniff", "asset responses should include security headers");
assert(assetResponse.headers.get("Referrer-Policy") === "strict-origin-when-cross-origin", "asset responses should preserve an origin referrer for Maps key restrictions");

console.log("Worker routes OK: config, origin guard, validation, static asset headers");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

if (!html.includes('id="map"')) throw new Error("Map container is missing");
if (!html.includes('id="lunchChoices"')) throw new Error("Lunch choices are missing");
if (!html.includes('id="lodgingChoices"')) throw new Error("Lodging choices are missing");
if (!html.includes('id="attractionChoices"')) throw new Error("Sightseeing choices are missing");
if (!html.includes('fetch("/api/route"')) throw new Error("Detailed route loading is missing");
if (!html.includes('value="guest_house"')) throw new Error("Lodging preference values are missing");
if (!html.includes('id="lodgingPreference"')) throw new Error("Single per-day lodging selection is missing");
if (!html.includes('enqueueRouteRequest')) throw new Error("Rate-aware route request queue is missing");
if (!html.includes('OpenStreetMap')) throw new Error("OpenStreetMap route attribution is missing");
if (!html.includes('target="_blank"')) throw new Error("External recommendation links are missing");
if (!html.includes('Phone not listed')) throw new Error("Phone availability is not shown on cards");

for (const [index, script] of scripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Inline script ${index + 1} is invalid: ${error.message}`);
  }
}

console.log(`Client HTML OK: ${scripts.length} inline script, ${Buffer.byteLength(html)} bytes`);

import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

if (!html.includes('id="map"')) throw new Error("Map container is missing");
if (!html.includes('id="lunchChoices"')) throw new Error("Lunch choices are missing");
if (!html.includes('id="lodgingChoices"')) throw new Error("Lodging choices are missing");
if (!html.includes('id="attractionChoices"')) throw new Error("Sightseeing choices are missing");
if (!html.includes('<title>Europe Bike Tour Planner</title>')) throw new Error("App header is missing");
if (!html.includes('Plan your next European bike tour.')) throw new Error("Neutral initial trip title is missing");
if (!html.includes('state.tripGenerated = true')) throw new Error("Generated trip title state is missing");
if (!html.includes('id="startCity" type="text"')) throw new Error("Editable starting city is missing");
if (!html.includes('id="endCity" type="text"')) throw new Error("Editable destination city is missing");
if (!html.includes('kind: "city"')) throw new Error("European city lookup is missing");
if (!html.includes('kind: "city_details"')) throw new Error("Selected city resolution is missing");
if (!html.includes('tripPlan: true')) throw new Error("Multi-day city route planning is missing");
if (html.includes('id="detailHeading"') || html.includes('Lunch details')) throw new Error("Redundant recommendation details panel is still present");
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

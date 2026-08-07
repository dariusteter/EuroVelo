import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

if (!html.includes('id="map"')) throw new Error("Map container is missing");
if (!html.includes('id="lunchChoices"')) throw new Error("Lunch choices are missing");
if (!html.includes('id="lodgingChoices"')) throw new Error("Lodging choices are missing");

for (const [index, script] of scripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Inline script ${index + 1} is invalid: ${error.message}`);
  }
}

console.log(`Client HTML OK: ${scripts.length} inline script, ${Buffer.byteLength(html)} bytes`);

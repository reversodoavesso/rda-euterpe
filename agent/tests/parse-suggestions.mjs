import { parseSuggestions, trimFinal } from "../src/agent.ts";

const cases = [
  ["plain array", '["Create a playlist with these tracks", "See similar artists", "Play now"]'],
  ["json fence", '```json\n["a", "b"]\n```'],
  ["plain fence", '```\n["a", "b"]\n```'],
  ["preamble", 'Sure! Here they are:\n["a", "b", "c"]'],
  ["wrapper object", '{"suggestions": ["a", "b"]}'],
  ["trailing comma", '["a", "b",]'],
  ["spotify template", '["Create playlist with {{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}", "See more"]'],
  ["loose text", "no array here"],
  ["empty", ""],
  ["non-string", '[1, "a", null, "b"]'],
  ["too long", '["' + "x".repeat(90) + '", "ok"]'],
];

let pass = 0;
for (const [name, input] of cases) {
  const out = parseSuggestions(input);
  const ok = Array.isArray(out) && out.every((s) => typeof s === "string" && s.length > 0 && s.length <= 80);
  if (ok) pass++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} -> ${JSON.stringify(out)}`);
}

// cases with expected counts
const expectCount = [
  ["plain array", 3],
  ["json fence", 2],
  ["plain fence", 2],
  ["preamble", 3],
  ["wrapper object", 2],
  ["trailing comma", 2],
  ["spotify template", 2],
  ["loose text", 0],
  ["empty", 0],
  ["non-string", 2],
  ["too long", 1],
];
let passCount = 0;
for (const [name, expected] of expectCount) {
  const found = cases.find(([n]) => n === name);
  const input = found ? found[1] : "";
  const out = parseSuggestions(input);
  if (out.length === expected) passCount++;
  else console.log(`  COUNT FAIL ${name}: expected ${expected}, got ${out.length}`);
}

// does the spotify template become a label?
const chip = parseSuggestions('["Create playlist with {{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}"]');
if (chip[0] === "Create playlist with Creep") passCount++;
else console.log(`  CHIP FAIL: ${JSON.stringify(chip)}`);

console.log(`\n${pass}/${cases.length} valid cases, ${passCount}/${expectCount.length + 1} correct counts`);

// ---- trimFinal ----
const trimCases = [
  ["short (no cut)", "short answer", 50, "short answer"],
  ["cut at paragraph", "aaaa bbbb\n\ncccc dddd", 15, "aaaa bbbb…"],
  ["cut at space", "aaaa bbbb cccc", 10, "aaaa bbbb…"],
  ["does not break template", "text {{spotify:track:abc123def456|Name}} continues", 30, "text…"],
  ["no cut when within limit", "x".repeat(100) + " end", 500, "x".repeat(100) + " end"],
];
let trimOk = 0;
for (const [name, input, max, expected] of trimCases) {
  const out = trimFinal(input, max);
  const ok = out === expected;
  if (ok) trimOk++;
  else console.log(`  TRIM FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(out)}`);
}
console.log(`trimFinal: ${trimOk}/${trimCases.length}`);

process.exit(pass === cases.length && passCount === expectCount.length + 1 && trimOk === trimCases.length ? 0 : 1);

import { parseSuggestions, trimFinal } from "../src/agent.ts";

const cases = [
  ["array puro", '["Criar playlist com essas faixas", "Ver artistas parecidos", "Tocar agora"]'],
  ["cerca json", '```json\n["a", "b"]\n```'],
  ["cerca pura", '```\n["a", "b"]\n```'],
  ["preambulo", 'Claro! Aqui estão:\n["a", "b", "c"]'],
  ["objeto wrapper", '{"suggestions": ["a", "b"]}'],
  ["virgula final", '["a", "b",]'],
  ["template spotify", '["Criar playlist com {{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}", "Ver mais"]'],
  ["texto solto", "nada de array aqui"],
  ["vazio", ""],
  ["nao-string", '[1, "a", null, "b"]'],
  ["longa demais", '["' + "x".repeat(90) + '", "ok"]'],
];

let pass = 0;
for (const [name, input] of cases) {
  const out = parseSuggestions(input);
  const ok = Array.isArray(out) && out.every((s) => typeof s === "string" && s.length > 0 && s.length <= 80);
  if (ok) pass++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} -> ${JSON.stringify(out)}`);
}

// casos com contagem esperada
const expectCount = [
  ["array puro", 3],
  ["cerca json", 2],
  ["cerca pura", 2],
  ["preambulo", 3],
  ["objeto wrapper", 2],
  ["virgula final", 2],
  ["template spotify", 2],
  ["texto solto", 0],
  ["vazio", 0],
  ["nao-string", 2],
  ["longa demais", 1],
];
let passCount = 0;
for (const [name, expected] of expectCount) {
  const found = cases.find(([n]) => n === name);
  const input = found ? found[1] : "";
  const out = parseSuggestions(input);
  if (out.length === expected) passCount++;
  else console.log(`  COUNT FAIL ${name}: esperado ${expected}, veio ${out.length}`);
}

// template spotify vira label?
const chip = parseSuggestions('["Criar playlist com {{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}"]');
if (chip[0] === "Criar playlist com Creep") passCount++;
else console.log(`  CHIP FAIL: ${JSON.stringify(chip)}`);

console.log(`\n${pass}/${cases.length} casos validos, ${passCount}/${expectCount.length + 1} contagens corretas`);

// ---- trimFinal ----
const trimCases = [
  ["curta (nao corta)", "resposta pequena", 50, "resposta pequena"],
  ["corta em paragrafo", "aaaa bbbb\n\ncccc dddd", 15, "aaaa bbbb…"],
  ["corta em espaco", "aaaa bbbb cccc", 10, "aaaa bbbb…"],
  ["nao quebra template", "texto {{spotify:track:abc123def456|Nome}} continua", 30, "texto…"],
  ["sem corte quando dentro do limite", "x".repeat(100) + " fim", 500, "x".repeat(100) + " fim"],
];
let trimOk = 0;
for (const [name, input, max, expected] of trimCases) {
  const out = trimFinal(input, max);
  const ok = out === expected;
  if (ok) trimOk++;
  else console.log(`  TRIM FAIL ${name}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(out)}`);
}
console.log(`trimFinal: ${trimOk}/${trimCases.length}`);

process.exit(pass === cases.length && passCount === expectCount.length + 1 && trimOk === trimCases.length ? 0 : 1);

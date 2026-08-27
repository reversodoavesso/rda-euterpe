import "dotenv/config";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().default("https://api.deepseek.com"),
  LLM_CHAT_MODEL: z.string().default("deepseek-v4-flash"),
  LLM_CURATION_MODEL: z.string().default("deepseek-v4-pro"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().default(8337),
  SEARXNG_URL: z.string().default("http://127.0.0.1:8888"),
  LASTFM_API_KEY: z.string().optional(),
  TASTEDIVE_API_KEY: z.string().optional(),
  DB_PATH: z.string().default("data/euterpe.db"),
  MAX_TOOL_STEPS: z.coerce.number().default(12),
  AUTO_ROUTING: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  CHAT_HISTORY: z.coerce.number().default(0),
  EUTERPE_DEBUG: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  WS_SECRET: z.string().optional(),
});

const parsed = EnvSchema.parse(process.env);

function loadSecret(): string {
  const fromEnv = parsed.WS_SECRET;
  if (fromEnv) return fromEnv;
  const dataDir = resolve(__dirname, "..", "data");
  const secretFile = resolve(dataDir, "ws-secret");
  if (existsSync(secretFile)) {
    return readFileSync(secretFile, "utf8").trim();
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

export interface AppConfig {
  deepseekApiKey?: string;
  llmBaseUrl: string;
  chatModel: string;
  curationModel: string;
  host: string;
  port: number;
  searxngUrl: string;
  lastfmApiKey?: string;
  tastediveApiKey?: string;
  dbPath: string;
  maxToolSteps: number;
  autoRouting: boolean;
  chatHistoryTurns: number;
  debug: boolean;
  wsSecret: string;
}

export const config: AppConfig = {
  deepseekApiKey: parsed.DEEPSEEK_API_KEY,
  llmBaseUrl: parsed.LLM_BASE_URL,
  chatModel: parsed.LLM_CHAT_MODEL,
  curationModel: parsed.LLM_CURATION_MODEL,
  host: parsed.HOST,
  port: parsed.PORT,
  searxngUrl: parsed.SEARXNG_URL,
  lastfmApiKey: parsed.LASTFM_API_KEY,
  tastediveApiKey: parsed.TASTEDIVE_API_KEY,
  dbPath: parsed.DB_PATH,
  maxToolSteps: parsed.MAX_TOOL_STEPS,
  autoRouting: parsed.AUTO_ROUTING,
  chatHistoryTurns: parsed.CHAT_HISTORY,
  debug: parsed.EUTERPE_DEBUG,
  wsSecret: loadSecret(),
};

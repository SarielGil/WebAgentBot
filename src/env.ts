import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, falling back to process.env');
    // Fall back entirely to process.env when the file is missing
    // (e.g. inside Docker where .env is not copied into the image but
    // env vars are injected via docker-compose env_file at runtime)
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (process.env[key]) result[key] = process.env[key] as string;
    }
    return result;
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  // Fall back to process.env for any keys not found in the file
  // (e.g. when running inside Docker where .env is not copied into the image)
  for (const key of keys) {
    if (!result[key] && process.env[key]) {
      result[key] = process.env[key] as string;
    }
  }

  return result;
}

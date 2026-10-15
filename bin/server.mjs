#!/usr/bin/env node
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';
import { jsonLog, start } from '../src/main.mjs';

// On SIGTERM or SIGINT the server stops taking webhooks, finishes the job in hand and exits.
try {
  const { stop } = await start();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stop(); });
} catch (error) {
  jsonLog({ level: 'error', event: 'start', code: error?.code ?? 'unexpected', message: error instanceof ShapeUpError ? error.message : undefined });
  process.exitCode = 1;
}

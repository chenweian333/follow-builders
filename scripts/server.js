#!/usr/bin/env node

// ============================================================================
// Follow Builders — Railway Entry Point
// ============================================================================
// Unified cloud process: Telegram bot + daily digest scheduler.
// Designed for Railway deployment; also works locally.
//
// Usage:  node scripts/server.js
// Env:    DATA_DIR, DIGEST_CRON, TZ, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY
//         TELEGRAM_CHAT_ID, DELIVERY_METHOD
// ============================================================================

import { mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import cron from 'node-cron';

const SCRIPT_DIR    = decodeURIComponent(new URL('.', import.meta.url).pathname);
const DATA_DIR      = process.env.DATA_DIR || join(homedir(), '.follow-builders');
const CRON_SCHEDULE = process.env.DIGEST_CRON || '0 8 * * *';
const TZ            = process.env.TZ || 'Asia/Shanghai';

// ── Validate required env vars ────────────────────────────────────────────────

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[server] FATAL: Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

if (!cron.validate(CRON_SCHEDULE)) {
  console.error(`[server] FATAL: Invalid DIGEST_CRON: "${CRON_SCHEDULE}"`);
  process.exit(1);
}

// ── Ensure DATA_DIR exists ────────────────────────────────────────────────────

await mkdir(DATA_DIR, { recursive: true });
console.log(`[server] DATA_DIR:  ${DATA_DIR}`);
console.log(`[server] Schedule:  "${CRON_SCHEDULE}" (${TZ})`);
console.log(`[server] Node:      ${process.execPath} ${process.version}`);

// ── Daily digest pipeline ─────────────────────────────────────────────────────

// Runs cron-run.sh as a subprocess, streaming its stdout/stderr to this process.
// cron-run.sh already sends a Telegram alert if any step fails.
function runDigest() {
  console.log('[server] digest: pipeline starting');
  const child = spawn('/bin/bash', [join(SCRIPT_DIR, 'cron-run.sh')], {
    // Pass NODE_BINARY so cron-run.sh uses the same node binary as server.js
    env: { ...process.env, NODE_BINARY: process.execPath },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('close', code => {
    if (code !== 0) console.error(`[server] digest: pipeline exited with code ${code}`);
    else console.log('[server] digest: pipeline complete');
  });
}

// ── Schedule ──────────────────────────────────────────────────────────────────

cron.schedule(CRON_SCHEDULE, runDigest, { timezone: TZ });
console.log('[server] Digest scheduled');

// ── Telegram bot ──────────────────────────────────────────────────────────────

// Spawns bot-server.js as a child process. Auto-restarts on crash with a 5s delay.
function startBot() {
  console.log('[server] bot: starting');
  const bot = spawn(process.execPath, [join(SCRIPT_DIR, 'bot-server.js')], {
    env: process.env,
    stdio: 'inherit',
  });
  bot.on('exit', (code, signal) => {
    console.error(`[server] bot: exited (code=${code}, signal=${signal}), restarting in 5s`);
    setTimeout(startBot, 5000);
  });
}

startBot();

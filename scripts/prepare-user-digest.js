#!/usr/bin/env node

// ============================================================================
// Follow Builders — User Digest Orchestrator
// ============================================================================
// Merges the central follow-builders feed (prepare-digest.js) with the user's
// personal sources (fetch-user-sources.js) into one JSON blob for the LLM.
//
// Also loads the user's custom summarize-user-sources.md prompt so the LLM
// knows how to handle YouTube titles and RSS descriptions (no transcripts).
//
// Usage: node prepare-user-digest.js
// Output: merged JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const USER_DIR   = process.env.DATA_DIR || join(homedir(), '.follow-builders');
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);

// Load a prompt file: user custom > local skills copy
async function loadPrompt(filename) {
  const userPath  = join(USER_DIR, 'prompts', filename);
  const localPath = join(SCRIPT_DIR, '..', 'prompts', filename);
  if (existsSync(userPath))  return readFile(userPath,  'utf-8');
  if (existsSync(localPath)) return readFile(localPath, 'utf-8');
  return '';
}

async function runScript(script) {
  const { stdout } = await exec(process.execPath, [join(SCRIPT_DIR, script)], {
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function main() {
  // Run both scripts in parallel
  const [central, userSources] = await Promise.allSettled([
    runScript('prepare-digest.js'),
    runScript('fetch-user-sources.js'),
  ]);

  if (central.status === 'rejected') {
    process.stderr.write(`prepare-user-digest: prepare-digest.js failed: ${central.reason?.message}\n`);
  }
  if (userSources.status === 'rejected') {
    process.stderr.write(`prepare-user-digest: fetch-user-sources.js failed: ${userSources.reason?.message}\n`);
  }

  const c = central.status === 'fulfilled' ? central.value : {
    status: 'error', error: central.reason?.message,
    podcasts: [], x: [], blogs: [], prompts: {}, stats: {}, config: {},
  };
  const u = userSources.status === 'fulfilled' ? userSources.value : {
    youtube: [], rss: [], stats: {}, errors: [userSources.reason?.message],
  };

  // Load the user-sources summarization prompt
  const summarizeUserSources = await loadPrompt('summarize-user-sources.md');

  const output = {
    ...c,

    // User sources appended to the central feed
    userSources: {
      youtube: u.youtube || [],
      rss:     u.rss     || [],
      stats:   u.stats   || {},
    },

    // Add the new prompt to the existing prompts map
    prompts: {
      ...c.prompts,
      ...(summarizeUserSources ? { summarize_user_sources: summarizeUserSources } : {}),
    },

    // Merged stats
    stats: {
      ...c.stats,
      userYoutubeSources: (u.youtube || []).length,
      userRssSources:     (u.rss     || []).length,
      userTotalItems:     u.stats?.totalItems || 0,
    },

    errors: [
      ...(c.errors || []),
      ...(u.errors || []),
    ].filter(Boolean),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});

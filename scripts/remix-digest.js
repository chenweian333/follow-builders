#!/usr/bin/env node

// ============================================================================
// Follow Builders — AI Remix Engine
// ============================================================================
// Reads the combined JSON from prepare-user-digest.js (via stdin),
// calls the Anthropic API to remix it into a polished digest, and
// outputs the digest text to stdout.
//
// Requires ANTHROPIC_API_KEY in ~/.follow-builders/.env
// Model: claude-haiku-4-5 by default (fast + cheap). Override with DIGEST_MODEL.
//
// Usage: node prepare-user-digest.js | node remix-digest.js
// Output: digest text to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

const USER_DIR = join(homedir(), '.follow-builders');
loadEnv({ path: join(USER_DIR, '.env') });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.DIGEST_MODEL || 'claude-haiku-4-5-20251001';

// ── Read stdin ────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// ── Call Anthropic API ────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMessage) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── Build the prompt ──────────────────────────────────────────────────────────

function buildPrompt(data) {
  const prompts  = data.prompts || {};
  const today    = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  const systemPrompt = prompts.digest_intro ||
    'You are an AI content curator producing a daily intelligence digest.';

  const sections = [];

  // 1. Official blogs (no X/Twitter)
  if (data.blogs?.length > 0) {
    sections.push('## OFFICIAL BLOGS\n\n' +
      data.blogs.map(b =>
        `### ${b.name}: ${b.title}\nURL: ${b.url}\nPublished: ${b.publishedAt || 'unknown'}\n\n${b.content?.slice(0, 3000) || ''}`
      ).join('\n\n---\n\n')
    );
  }

  // 2. Central podcasts (with full transcripts — write real 2-3 sentence summaries)
  if (data.podcasts?.length > 0) {
    sections.push('## PODCASTS (full transcripts — write a 2–3 sentence summary of what was actually discussed)\n\n' +
      data.podcasts.map(p =>
        `### ${p.name}: ${p.title}\nURL: ${p.url}\nPublished: ${p.publishedAt || 'unknown'}\n\nTRANSCRIPT:\n${p.transcript?.slice(0, 8000) || '(no transcript)'}`
      ).join('\n\n---\n\n')
    );
  }

  // 3. User YouTube channels (write real 2-3 sentence summaries from title + description)
  const yt = data.userSources?.youtube || [];
  if (yt.length > 0) {
    sections.push('## YOUTUBE CHANNELS (write a 2–3 sentence summary of what the video covers — use the title and description)\n\n' +
      yt.map(ch =>
        `### ${ch.name} (category: ${ch.category})\n` +
        ch.items.map(v =>
          `- **${v.title}**\n  Published: ${v.publishedAt || 'unknown'}\n  URL: ${v.url}` +
          (v.description ? `\n  Description: ${v.description.slice(0, 600)}` : '')
        ).join('\n')
      ).join('\n\n')
    );
  }

  // 4. User RSS podcasts, blogs, newsletters
  const rss = data.userSources?.rss || [];
  if (rss.length > 0) {
    sections.push('## RSS PODCASTS & NEWSLETTERS (write a 2–3 sentence summary from title + description)\n\n' +
      rss.map(src =>
        `### ${src.name} (${src.source}, category: ${src.category})\n` +
        src.items.map(i =>
          `- **${i.title}**\n  Published: ${i.publishedAt || 'unknown'}\n  URL: ${i.url}` +
          (i.description ? `\n  Summary: ${i.description.slice(0, 600)}` : '')
        ).join('\n')
      ).join('\n\n')
    );
  }

  const hasContent = data.blogs?.length > 0 || data.podcasts?.length > 0 || yt.length > 0 || rss.length > 0;
  if (!hasContent) return null;

  const userMessage = `Today is ${today}. Select the 5–8 most important items from the content below.\n\n` +
    `CRITICAL REQUIREMENTS:\n` +
    `1. Use 繁體中文 (Traditional Chinese) exclusively — NOT 简体字\n` +
    `2. Each item MUST follow this exact 4-line format:\n` +
    `[📝 or 🎙️ or 📺] **繁體中文標題**\n` +
    `💡 2–3句繁體中文摘要\n` +
    `🌱 <b><i>"most impactful quote in English"</i></b>\n` +
    `    <i>「繁體中文翻譯」</i>\n` +
    `🔗 https://...\n\n` +
    `3. Separate items with ---\n` +
    `4. No section headers, no English, no extra lines, no header, no footer\n\n` +
    sections.join('\n\n====\n\n');

  return { systemPrompt, userMessage };
}

// ── Header / footer wrapper ───────────────────────────────────────────────────

const SOURCE_EMOJI_RE = /^[📝📺🎙️🔥]/u;

function normalizeBody(body) {
  // Strip leading --- if Claude opened with one
  body = body.replace(/^\s*---\s*\n/, '');
  // Convert **text** or *text* (markdown bold) to <b>text</b> (Telegram HTML)
  body = body.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  body = body.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  // Strip any remaining stray asterisks
  body = body.replace(/\*/g, '');
  // Ensure 💡 prefix on summary lines (non-empty lines that aren't title/url/separator/trending)
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() &&
        !SOURCE_EMOJI_RE.test(line) &&
        !line.startsWith('💡') &&
        !line.startsWith('🌱') &&
        !line.startsWith('🔗') &&
        !line.startsWith('🔥') &&
        !line.startsWith('---') &&
        !line.startsWith('<b>') &&
        !line.startsWith('<i>') &&
        !line.trimStart().startsWith('<i>') &&
        !line.startsWith('🌟') &&
        !line.startsWith('📅') &&
        !line.startsWith('━') &&
        !line.startsWith('✨')) {
      out.push('💡 ' + line.replace(/^💡\s*/, ''));
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function wrapWithChrome(body) {
  body = normalizeBody(body);
  const date = new Date().toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const itemCount = (body.match(/^[📝📺🎙️].+/gmu) || []).length;

  const header = [
    '🌟 今日精選 | Daily Intelligence Digest',
    `📅 ${date}`,
    '━━━━━━━━━━━━━━━',
    '',
  ].join('\n');

  const footer = [
    '',
    '━━━━━━━━━━━━━━━',
    `✨ 共 ${itemCount} 則精選內容 | ${itemCount} curated items today`,
  ].join('\n');

  return header + body + footer;
}

// ── Fallback: simple list if no API key ───────────────────────────────────────

function buildFallbackDigest(data) {
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [`AI Builders Digest — ${today}\n(Fallback mode — Anthropic API unavailable)\n`];

  if (data.blogs?.length > 0) {
    lines.push('📰 Blogs');
    for (const b of data.blogs) lines.push(`• ${b.name}: ${b.title}\n  ${b.url}`);
  }
  if (data.podcasts?.length > 0) {
    lines.push('\n🎙 Podcasts');
    for (const p of data.podcasts) lines.push(`• ${p.name}: ${p.title}\n  ${p.url}`);
  }
  const yt = data.userSources?.youtube || [];
  if (yt.length > 0) {
    lines.push('\n▶ YouTube');
    for (const ch of yt) {
      for (const v of ch.items) lines.push(`• ${ch.name}: ${v.title}\n  ${v.url}`);
    }
  }
  const rss = data.userSources?.rss || [];
  if (rss.length > 0) {
    lines.push('\n📡 Podcasts & Newsletters');
    for (const src of rss) {
      for (const i of src.items) lines.push(`• ${src.name}: ${i.title}\n  ${i.url}`);
    }
  }
  lines.push('\nGenerated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw  = await readStdin();
  if (!raw.trim()) {
    process.stderr.write('remix-digest.js: no input received\n');
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    process.stderr.write(`remix-digest.js: JSON parse error: ${e.message}\n`);
    process.exit(1);
  }

  if (!API_KEY) {
    process.stderr.write('remix-digest.js: no ANTHROPIC_API_KEY — using fallback digest\n');
    process.stdout.write(wrapWithChrome(buildFallbackDigest(data)));
    return;
  }

  const built = buildPrompt(data);
  if (!built) {
    process.stderr.write('remix-digest.js: no content to remix\n');
    process.stdout.write('No new content today from your builders.');
    return;
  }

  let digest;
  try {
    digest = await callClaude(built.systemPrompt, built.userMessage);
    // Strip any header/footer Claude added despite instructions
    digest = digest.replace(/^.*AI Builders Digest.*\n?/m, '');
    digest = digest.replace(/\n*Generated through the Follow Builders skill:.*$/s, '');
    digest = digest.trimStart().trimEnd();
  } catch (e) {
    process.stderr.write(`remix-digest.js: Claude API failed (${e.message}) — using fallback digest\n`);
    digest = buildFallbackDigest(data);
  }
  process.stdout.write(wrapWithChrome(digest));
}

main().catch(err => {
  process.stderr.write(`remix-digest.js error: ${err.message}\n`);
  process.exit(1);
});

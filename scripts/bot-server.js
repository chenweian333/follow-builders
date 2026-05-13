#!/usr/bin/env node

// ============================================================================
// Follow Builders — Interactive Telegram Bot
// ============================================================================
// Long-polls Telegram for incoming messages and replies using Claude AI,
// drawing context from the local SQLite digest database.
//
// Run:  node bot-server.js
// Logs: ~/.follow-builders/bot.log
//
// Features:
//   - Conversation memory per chat (last 20 messages)
//   - DB search to find relevant digest items for context
//   - URL content fetching for blogs/articles
//   - Responds in Traditional Chinese; keeps English quotes/names in English
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import { YoutubeTranscript } from 'youtube-transcript';

const USER_DIR  = process.env.DATA_DIR || join(homedir(), '.follow-builders');
const OFFSET_FILE = join(USER_DIR, 'bot-offset.json');
const DB_PATH   = join(USER_DIR, 'content.db');

loadEnv({ path: join(USER_DIR, '.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const MODEL     = process.env.DIGEST_MODEL || 'claude-haiku-4-5-20251001';

const MAX_HISTORY = 20; // messages per chat session

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Conversation sessions (in-memory) ─────────────────────────────────────────

const sessions = new Map(); // chatId -> [{ role, content }, ...]

function getHistory(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  return sessions.get(chatId);
}

function pushHistory(chatId, role, content) {
  const hist = getHistory(chatId);
  hist.push({ role, content });
  // Trim oldest pairs when over limit
  while (hist.length > MAX_HISTORY) hist.splice(0, 2);
  return hist;
}

// ── SQLite helpers ────────────────────────────────────────────────────────────

function dbSearch(query, limit = 4) {
  if (!existsSync(DB_PATH)) return [];
  const db = new DatabaseSync(DB_PATH);
  try {
    // FTS5 first
    try {
      const rows = db.prepare(`
        SELECT i.source_type, i.source_name, i.title, i.url,
               i.description, i.raw_content,
               snippet(items_fts, 0, '', '', '...', 48) as fts_title
        FROM items_fts
        JOIN items i ON items_fts.rowid = i.id
        WHERE items_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit);
      if (rows.length > 0) return rows;
    } catch {}
    // LIKE fallback
    const like = `%${query}%`;
    return db.prepare(`
      SELECT source_type, source_name, title, url, description, raw_content
      FROM items
      WHERE title LIKE ? OR description LIKE ? OR raw_content LIKE ? OR source_name LIKE ?
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(like, like, like, like, limit);
  } finally {
    db.close();
  }
}

function dbRecent(limit = 5) {
  if (!existsSync(DB_PATH)) return [];
  const db = new DatabaseSync(DB_PATH);
  try {
    return db.prepare(`
      SELECT source_type, source_name, title, url, description, raw_content
      FROM items
      ORDER BY fetched_at DESC
      LIMIT ?
    `).all(limit);
  } finally {
    db.close();
  }
}

// ── URL content fetching ──────────────────────────────────────────────────────

function extractYouTubeId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m?.[1] || null;
}

async function fetchYouTubeTranscript(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 12000);
  } catch {
    return null;
  }
}

async function fetchArticleText(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; digest-bot/1.0)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10000);
  } catch {
    return null;
  }
}

// ── Build context block for Claude ───────────────────────────────────────────

async function fetchFullContent(item) {
  // Prefer whatever was already stored
  if (item.raw_content?.length > 200) return item.raw_content.slice(0, 10000);

  const type = item.source_type;
  const url  = item.url;

  if (type === 'youtube') {
    const transcript = await fetchYouTubeTranscript(url);
    if (transcript) return `[YouTube Transcript]\n${transcript}`;
    return item.description?.slice(0, 1500) || '';
  }

  if (type === 'blog' || type === 'newsletter') {
    const article = await fetchArticleText(url);
    if (article) return article;
    return item.description?.slice(0, 1500) || '';
  }

  if (type === 'podcast') {
    const desc = item.description?.slice(0, 2000) || '';
    return desc
      ? `${desc}\n[Note: full audio transcript unavailable — summary based on episode description]`
      : '';
  }

  // x/tweet, rss, unknown
  return item.description?.slice(0, 1500) || '';
}

async function buildContext(userText) {
  let items = dbSearch(userText);
  if (items.length === 0) items = dbRecent(4);

  const enriched = await Promise.all(items.map(async item => ({
    header: `[${item.source_type.toUpperCase()}] ${item.source_name}: ${item.title}`,
    url: item.url,
    body: await fetchFullContent(item),
  })));

  return enriched
    .map(e => `${e.header}\nURL: ${e.url}${e.body ? '\n' + e.body : ''}`)
    .join('\n\n---\n\n');
}

// ── System prompt ─────────────────────────────────────────────────────────────

const BASE_SYSTEM = `你是一位智慧的知識夥伴，專門協助用戶深入探討每日精選內容（AI/科技、商業、心理學、哲學、健康科學）。

你的角色：
- 像一位博學的老師和思想討論夥伴，而不只是摘要工具
- 提供深度分析，連結不同主題的概念，分享你的見解
- 若用戶問題模糊，主動詢問澄清
- 鼓勵批判性思考，挑戰表面結論，引導更深的探討

語言規則：
- 始終以繁體中文回應
- 保留英文專有名詞、人名、公司名（如 "Claude", "Baseten", "Naval Ravikant"）
- 直接引用英文原文時保持英文（如 "Talk is cheap. Send patches."）
- 語氣：聰明、好奇、略帶對話感——像一位讀遍所有資料的好友

回應長度：
- 直接問題：2–4段，有深度但不冗長
- 開放討論：可以更長，用小標題分隔
- 若不確定用戶指的是哪個內容，先猜測並確認

格式規則（重要）：
- 用 ## 小標題來分段（會自動轉為粗體加 emoji）
- 用 **粗體** 標記關鍵詞
- 用 - 開頭列出重點清單
- 不要使用其他 markdown 符號`;

function buildSystemPrompt(contextBlock) {
  if (!contextBlock) return BASE_SYSTEM;
  return BASE_SYSTEM + '\n\n## 相關精選內容（用於回答）\n\n' + contextBlock;
}

// ── Reply formatter (markdown → Telegram HTML) ───────────────────────────────

function headingEmoji(heading) {
  const h = heading.toLowerCase();
  if (/為何|原因|why|因為|reason/.test(h)) return '🤔';
  if (/核心|關鍵|重點|key|critical/.test(h)) return '🔑';
  if (/未來|機會|趨勢|future|opportunity/.test(h)) return '🚀';
  if (/競爭|優勢|護城河|moat|advantage/.test(h)) return '🏆';
  if (/情商|心理|emotional|感知/.test(h)) return '🧠';
  if (/ai|人工智能|科技|technology/.test(h)) return '🤖';
  if (/商業|market|市場|business/.test(h)) return '💼';
  if (/結論|總結|conclusion|summary/.test(h)) return '🎯';
  if (/挑戰|問題|challenge|issue/.test(h)) return '⚡';
  if (/洞察|分析|insight|analysis/.test(h)) return '💎';
  if (/研究|數據|research|data/.test(h)) return '🔍';
  return '💡';
}

function formatReply(text) {
  return text
    // Escape bare & that aren't already HTML entities
    .replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, '&amp;')
    // ## / ### headings → emoji <b>heading</b>  (strip any ** inside first to avoid double-bold)
    .replace(/^#{1,3}\s+(.+)$/gm, (_, h) => {
      const clean = h.trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*/g, '');
      return `\n${headingEmoji(clean)} <b>${clean}</b>`;
    })
    // **bold** → <b>bold</b>
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    // Remaining *text* → strip asterisks (avoid random italics)
    .replace(/\*([^*\n]+)\*/g, '$1')
    // Strip any leftover * or # characters
    .replace(/\*/g, '').replace(/^#+\s*/gm, '')
    // - or * bullet points → •
    .replace(/^[ \t]*[-–]\s+/gm, '• ')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Claude API ────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '（無回應）';
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(chatId, text, replyToText) {
  // If replying to a bot message, include that as extra context
  const query = replyToText ? `${replyToText.slice(0, 200)} ${text}` : text;
  const contextBlock = await buildContext(query);
  const systemPrompt = buildSystemPrompt(contextBlock);

  const history = getHistory(chatId);
  const messages = [
    ...history,
    { role: 'user', content: text },
  ];

  const raw   = await callClaude(systemPrompt, messages);
  const reply = formatReply(raw);
  pushHistory(chatId, 'user', text);
  pushHistory(chatId, 'assistant', reply);
  return reply;
}

// ── Telegram API ──────────────────────────────────────────────────────────────

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgFetch(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getUpdates(offset) {
  const res = await fetch(
    `${TG}/getUpdates?offset=${offset}&timeout=30&allowed_updates=message`,
    { signal: AbortSignal.timeout(35000) },
  );
  return res.json();
}

async function sendMessage(chatId, text, replyToId) {
  const MAX = 4000;
  const chunks = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= MAX) { chunks.push(rem); break; }
    let at = rem.lastIndexOf('\n', MAX);
    if (at < MAX * 0.5) at = MAX;
    chunks.push(rem.slice(0, at));
    rem = rem.slice(at);
  }
  for (let i = 0; i < chunks.length; i++) {
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(i === 0 && replyToId ? { reply_to_message_id: replyToId } : {}),
    });
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}

async function sendTyping(chatId) {
  await tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' });
}

// ── Offset persistence ────────────────────────────────────────────────────────

async function loadOffset() {
  try {
    if (existsSync(OFFSET_FILE)) {
      return JSON.parse(await readFile(OFFSET_FILE, 'utf-8')).offset || 0;
    }
  } catch {}
  return 0;
}

async function saveOffset(offset) {
  await writeFile(OFFSET_FILE, JSON.stringify({ offset }));
}

// ── Polling loop ──────────────────────────────────────────────────────────────

async function poll() {
  let offset = await loadOffset();
  log(`Bot started (pid=${process.pid}, offset=${offset}, model=${MODEL})`);

  while (true) {
    try {
      const data = await getUpdates(offset);
      if (!data.ok || !Array.isArray(data.result)) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;
        await saveOffset(offset);

        const msg = update.message;
        if (!msg?.text) continue;

        const chatId  = msg.chat.id;
        const msgId   = msg.message_id;
        const text    = msg.text.trim();
        const replyTo = msg.reply_to_message?.text || null;

        log(`[${chatId}] "${text.slice(0, 80)}"`);

        if (text === '/start') {
          await sendMessage(chatId,
            '你好！我是你的 <b>AI Builders Digest</b> 對話助手 🤖\n\n' +
            '你可以問我關於每日精選內容的任何問題，或直接回覆某一則內容繼續深入討論。\n\n' +
            '我會根據最近的文章、Podcast 和 YouTube 影片來回答你，像一位讀過所有資料的知識夥伴。\n\n' +
            '有什麼想聊的？',
            msgId,
          );
          continue;
        }

        if (text === '/clear') {
          sessions.delete(chatId);
          await sendMessage(chatId, '✅ 對話記憶已清除，重新開始。', msgId);
          continue;
        }

        await sendTyping(chatId);

        try {
          const reply = await handleMessage(chatId, text, replyTo);
          await sendMessage(chatId, reply, msgId);
          log(`[${chatId}] replied (${reply.length} chars)`);
        } catch (e) {
          log(`[${chatId}] error: ${e.message}`);
          await sendMessage(chatId, '抱歉，處理訊息時發生錯誤，請稍後再試。', msgId);
        }
      }
    } catch (e) {
      if (!e.message.includes('abort')) log(`Polling error: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!API_KEY)   { console.error('ANTHROPIC_API_KEY missing');   process.exit(1); }

poll().catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });

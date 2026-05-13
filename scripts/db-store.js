#!/usr/bin/env node

// ============================================================================
// Follow Builders — Content Database
// ============================================================================
// Stores all fetched content (tweets, podcast episodes, YouTube videos, blog
// posts, newsletters) and daily digest text in a local SQLite database.
//
// Database: ~/.follow-builders/content.db
//
// Usage:
//   node db-store.js --raw /tmp/fb-raw.json --digest /tmp/fb-digest.txt
//
// Querying (in Claude conversation):
//   Run: node db-store.js --search "RAG last week"
//   Or ask Claude to query it directly via Bash tool
//
// Schema:
//   items   — every piece of raw content ever fetched
//   digests — daily digest text
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DatabaseSync } from 'node:sqlite';

const USER_DIR = join(homedir(), '.follow-builders');
const DB_PATH  = join(USER_DIR, 'content.db');

// ── Database setup ────────────────────────────────────────────────────────────

function openDb() {
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type  TEXT    NOT NULL,
      source_name  TEXT    NOT NULL,
      category     TEXT,
      title        TEXT,
      url          TEXT    UNIQUE,
      published_at TEXT,
      description  TEXT,
      raw_content  TEXT,
      fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_items_source_name  ON items(source_name);
    CREATE INDEX IF NOT EXISTS idx_items_source_type  ON items(source_type);
    CREATE INDEX IF NOT EXISTS idx_items_fetched_at   ON items(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      title, description, raw_content, source_name,
      content='items', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS items_fts_insert
    AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, description, raw_content, source_name)
      VALUES (new.id, new.title, new.description, new.raw_content, new.source_name);
    END;

    CREATE TRIGGER IF NOT EXISTS items_fts_update
    AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, description, raw_content, source_name)
      VALUES ('delete', old.id, old.title, old.description, old.raw_content, old.source_name);
      INSERT INTO items_fts(rowid, title, description, raw_content, source_name)
      VALUES (new.id, new.title, new.description, new.raw_content, new.source_name);
    END;

    CREATE TABLE IF NOT EXISTS digests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date         TEXT    NOT NULL UNIQUE,
      content      TEXT    NOT NULL,
      generated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Rebuild FTS index if it's empty but items table has data (first-run fix)
  const ftsCount   = db.prepare('SELECT COUNT(*) as c FROM items_fts').get();
  const itemsCount = db.prepare('SELECT COUNT(*) as c FROM items').get();
  if (ftsCount.c === 0 && itemsCount.c > 0) {
    db.exec(`INSERT INTO items_fts(items_fts) VALUES('rebuild')`);
  }

  return db;
}

// ── Store items ───────────────────────────────────────────────────────────────

function storeItems(db, rawData) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (source_type, source_name, category, title, url, published_at, description, raw_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;

  // X/Twitter tweets
  for (const builder of (rawData.x || [])) {
    for (const tweet of (builder.tweets || [])) {
      const r = insert.run(
        'tweet', builder.name, 'ai_tech',
        tweet.text?.slice(0, 200),
        tweet.url,
        tweet.createdAt || null,
        null,
        tweet.text || null,
      );
      count += r.changes;
    }
  }

  // Central podcasts (with transcripts)
  for (const ep of (rawData.podcasts || [])) {
    const r = insert.run(
      'podcast', ep.name, null,
      ep.title,
      ep.url,
      ep.publishedAt || null,
      null,
      ep.transcript?.slice(0, 20000) || null,
    );
    count += r.changes;
  }

  // Central blog posts
  for (const post of (rawData.blogs || [])) {
    const r = insert.run(
      'blog', post.name, null,
      post.title,
      post.url,
      post.publishedAt || null,
      post.description || null,
      post.content?.slice(0, 20000) || null,
    );
    count += r.changes;
  }

  // User YouTube videos
  for (const ch of (rawData.userSources?.youtube || [])) {
    for (const v of (ch.items || [])) {
      const r = insert.run(
        'youtube', ch.name, ch.category || null,
        v.title,
        v.url,
        v.publishedAt || null,
        v.description || null,
        null,
      );
      count += r.changes;
    }
  }

  // User RSS (podcasts + blogs + newsletters)
  for (const src of (rawData.userSources?.rss || [])) {
    for (const item of (src.items || [])) {
      const r = insert.run(
        src.source || 'rss', src.name, src.category || null,
        item.title,
        item.url || null,
        item.publishedAt || null,
        item.description || null,
        null,
      );
      count += r.changes;
    }
  }

  return count;
}

function storeDigest(db, digestText) {
  const today = new Date().toISOString().split('T')[0];
  const stmt  = db.prepare(`
    INSERT OR REPLACE INTO digests (date, content, generated_at)
    VALUES (?, ?, datetime('now'))
  `);
  stmt.run(today, digestText);
}

// ── Search ────────────────────────────────────────────────────────────────────

function likeSearch(db, query, limit) {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT id, source_type, source_name, title, url, published_at, fetched_at,
           substr(coalesce(description, raw_content, ''), 1, 200) as snippet
    FROM items
    WHERE title LIKE ? OR description LIKE ? OR raw_content LIKE ? OR source_name LIKE ?
    ORDER BY fetched_at DESC
    LIMIT ?
  `).all(like, like, like, like, limit);
}

function search(db, query, limit = 20) {
  // Try FTS5 full-text search first; fall back to LIKE on error or empty results
  try {
    const rows = db.prepare(`
      SELECT i.id, i.source_type, i.source_name, i.title, i.url, i.published_at, i.fetched_at,
             snippet(items_fts, 1, '**', '**', '...', 32) as snippet
      FROM items_fts
      JOIN items i ON items_fts.rowid = i.id
      WHERE items_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit);
    if (rows.length > 0) return rows;
  } catch { /* fall through */ }
  return likeSearch(db, query, limit);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getStats(db) {
  const totals = db.prepare(`SELECT source_type, COUNT(*) as count FROM items GROUP BY source_type`).all();
  const recent = db.prepare(`SELECT COUNT(*) as count FROM items WHERE fetched_at > datetime('now', '-7 days')`).get();
  const oldest = db.prepare(`SELECT MIN(fetched_at) as oldest FROM items`).get();
  const digests = db.prepare(`SELECT COUNT(*) as count FROM digests`).get();
  return { byType: totals, last7Days: recent.count, since: oldest.oldest, digestCount: digests.count };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Search mode
  const searchIdx = args.indexOf('--search');
  if (searchIdx !== -1) {
    const query = args[searchIdx + 1];
    if (!query) { console.error('Usage: node db-store.js --search "query"'); process.exit(1); }
    const db  = openDb();
    const rows = search(db, query);
    db.close();
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Stats mode
  if (args.includes('--stats')) {
    const db   = openDb();
    const stats = getStats(db);
    db.close();
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  // Store mode (default): --raw <file> [--digest <file>]
  const rawIdx    = args.indexOf('--raw');
  const digestIdx = args.indexOf('--digest');

  const rawFile    = rawIdx    !== -1 ? args[rawIdx + 1]    : null;
  const digestFile = digestIdx !== -1 ? args[digestIdx + 1] : null;

  if (!rawFile && !digestFile) {
    console.error('Usage: node db-store.js --raw /tmp/fb-raw.json [--digest /tmp/fb-digest.txt]');
    process.exit(1);
  }

  const db = openDb();
  let itemsStored = 0;

  if (rawFile && existsSync(rawFile)) {
    const rawData = JSON.parse(await readFile(rawFile, 'utf-8'));
    itemsStored = storeItems(db, rawData);
  }

  if (digestFile && existsSync(digestFile)) {
    const digestText = await readFile(digestFile, 'utf-8');
    if (digestText.trim()) storeDigest(db, digestText);
  }

  db.close();

  console.log(JSON.stringify({
    status: 'ok',
    itemsStored,
    message: `Stored ${itemsStored} new item(s) to ${DB_PATH}`,
  }));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});

/**
 * Dreinnify — музыкальная платформа с рецензиями, оценками, караоке и Telegram-авторизацией
 * Всё в одном файле: Express-сервер, Telegram-бот, SQLite, Deezer API, YouTube Music интеграция
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const { createCanvas, loadImage, registerFont } = require('canvas');
const { spawn } = require('child_process');
const ytdl = require('@distube/ytdl-core');
const YouTubeMusic = require('youtube-music-api');

// ============ КОНФИГ ============
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'DreinnifyBot';
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dreinnify-secret-change-me';

// ============ БАЗА ДАННЫХ ============
const DB_PATH = path.join(__dirname, 'data', 'dreinnify.db');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  photo_url TEXT,
  bio TEXT DEFAULT '',
  verified INTEGER DEFAULT 0,
  verify_status TEXT DEFAULT 'none', -- none | pending | approved | rejected
  is_banned INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  telegram_id TEXT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  photo_url TEXT,
  used INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_type TEXT NOT NULL, -- track | album
  item_id TEXT NOT NULL,
  item_title TEXT,
  item_artist TEXT,
  item_cover TEXT,
  rhymes INTEGER DEFAULT 0,
  structure INTEGER DEFAULT 0,
  style INTEGER DEFAULT 0,
  charisma INTEGER DEFAULT 0,
  vibe INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  title TEXT DEFAULT '',
  body TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id, item_type, item_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_title TEXT,
  item_artist TEXT,
  item_cover TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id, item_type, item_id)
);

CREATE TABLE IF NOT EXISTS verify_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  socials TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', -- pending | approved | rejected
  created_at INTEGER DEFAULT (strftime('%s','now')),
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS nominations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  bg_color TEXT DEFAULT '#0f0f14',
  text_color TEXT DEFAULT '#ffffff',
  accent_color TEXT DEFAULT '#7c5cff',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT,
  data TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

const log = (event, data = {}) => {
  try { db.prepare('INSERT INTO logs (event, data) VALUES (?,?)').run(event, JSON.stringify(data)); } catch {}
};

// ============ TELEGRAM БОТ ============
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match && match[1] ? match[1].trim() : '';
    const from = msg.from;

    if (payload && payload.startsWith('auth_')) {
      const token = payload.substring(5);
      const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ? AND used = 0').get(token);
      if (!row) {
        return bot.sendMessage(chatId, '⚠️ Ссылка авторизации недействительна или устарела. Обновите страницу входа.');
      }
      db.prepare(`UPDATE auth_tokens SET telegram_id=?, username=?, first_name=?, last_name=?, photo_url=?, used=1 WHERE token=?`).run(
        String(from.id), from.username || '', from.first_name || '', from.last_name || '', '', token
      );

      // upsert user
      const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(from.id));
      if (!existing) {
        db.prepare(`INSERT INTO users (telegram_id, username, first_name, last_name) VALUES (?,?,?,?)`).run(
          String(from.id), from.username || '', from.first_name || '', from.last_name || ''
        );
      } else {
        db.prepare(`UPDATE users SET username=?, first_name=?, last_name=? WHERE telegram_id=?`).run(
          from.username || '', from.first_name || '', from.last_name || '', String(from.id)
        );
      }

      await bot.sendMessage(chatId,
        `✅ *Dreinnify* — вход подтверждён!\n\nВозвращайтесь на сайт, авторизация завершится автоматически.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await bot.sendMessage(chatId,
      `🎧 *Dreinnify*\nМинималистичная платформа рецензий и оценок русскоязычной музыки.\n\n` +
      `Чтобы войти на сайт — откройте [${DOMAIN}](${DOMAIN}) и нажмите «Войти через Telegram».`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  });

  bot.on('polling_error', (e) => console.error('[bot polling]', e.message));
  console.log('[bot] started');
} else {
  console.warn('[bot] BOT_TOKEN не указан в .env — авторизация работать не будет');
}

// ============ УТИЛИТЫ ============
const httpGetJSON = (url, opts = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({
    method: 'GET',
    hostname: u.hostname,
    path: u.pathname + u.search,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    headers: { 'User-Agent': 'Dreinnify/1.0', 'Accept': 'application/json', ...(opts.headers || {}) },
    timeout: opts.timeout || 15000,
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); }
    });
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  req.end();
});

// Deezer API через CORS-прокси не нужен — сервер сам обращается
const DEEZER_BASE = 'https://api.deezer.com';
async function deezerSearch(q, type = 'track', limit = 25) {
  const url = `${DEEZER_BASE}/search/${type}?q=${encodeURIComponent(q)}&limit=${limit}`;
  return httpGetJSON(url);
}
async function deezerGet(type, id) {
  return httpGetJSON(`${DEEZER_BASE}/${type}/${id}`);
}

// YouTube Music API
const ytm = new YouTubeMusic();
let ytmInited = false;
async function ensureYTM() {
  if (!ytmInited) { await ytm.initalize(); ytmInited = true; }
}
async function ytmFindTrack(query) {
  try {
    await ensureYTM();
    const res = await ytm.search(query, 'song');
    const items = (res && res.content) || [];
    return items[0] || null;
  } catch (e) {
    console.warn('[ytm]', e.message);
    return null;
  }
}

// ============ EXPRESS ============
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// Загрузка (для аватаров / номинаций)
const upload = multer({
  dest: path.join(__dirname, 'public', 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }
});
if (!fs.existsSync(path.join(__dirname, 'public', 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });
}

// Мидлварь
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  const user = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(req.session.userId);
  if (!user || String(user.telegram_id) !== ADMIN_ID) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ============ АУТЕНТИФИКАЦИЯ ============
app.post('/api/auth/request', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO auth_tokens (token) VALUES (?)').run(token);
  const link = `https://t.me/${BOT_USERNAME}?start=auth_${token}`;
  res.json({ token, link });
});

app.get('/api/auth/check', (req, res) => {
  const { token } = req.query;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ?').get(token);
  if (!row || !row.used) return res.json({ ok: false });
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(row.telegram_id);
  if (!user) return res.json({ ok: false });
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    telegram_id: u.telegram_id,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    photo_url: u.photo_url,
    bio: u.bio,
    verified: !!u.verified,
    verify_status: u.verify_status,
    is_admin: String(u.telegram_id) === ADMIN_ID,
  };
}

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: publicUser(u) });
});

app.post('/api/me/update', requireAuth, (req, res) => {
  const { bio, first_name } = req.body;
  db.prepare('UPDATE users SET bio = COALESCE(?, bio), first_name = COALESCE(?, first_name) WHERE id = ?')
    .run(bio ?? null, first_name ?? null, req.session.userId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: publicUser(u) });
});

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const url = '/uploads/' + path.basename(req.file.path);
  db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run(url, req.session.userId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: publicUser(u) });
});

// ============ ПОИСК (Deezer + приоритет русских артистов) ============
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [] });
  try {
    const [tracksRaw, albumsRaw, artistsRaw] = await Promise.all([
      deezerSearch(q, 'track', 30).catch(() => ({ data: [] })),
      deezerSearch(q, 'album', 15).catch(() => ({ data: [] })),
      deezerSearch(q, 'artist', 10).catch(() => ({ data: [] })),
    ]);

    // умный сорт: русские (кириллица) вперёд
    const isRu = (s) => /[а-яА-ЯёЁ]/.test(s || '');
    const sortRuFirst = (arr, keys) => arr.sort((a, b) => {
      const ar = keys.some(k => isRu(a[k])) ? 0 : 1;
      const br = keys.some(k => isRu(b[k])) ? 0 : 1;
      return ar - br;
    });

    const tracks = sortRuFirst((tracksRaw.data || []).map(t => ({
      id: String(t.id),
      title: t.title,
      artist: t.artist ? t.artist.name : '',
      artists: t.contributors ? t.contributors.map(c => c.name) : (t.artist ? [t.artist.name] : []),
      album: t.album ? t.album.title : '',
      album_id: t.album ? String(t.album.id) : '',
      cover: t.album ? (t.album.cover_medium || t.album.cover) : '',
      preview: t.preview,
      duration: t.duration,
    })), ['title', 'artist']);

    const albums = sortRuFirst((albumsRaw.data || []).map(a => ({
      id: String(a.id),
      title: a.title,
      artist: a.artist ? a.artist.name : '',
      cover: a.cover_medium || a.cover,
      tracks: a.nb_tracks,
    })), ['title', 'artist']);

    const artists = sortRuFirst((artistsRaw.data || []).map(a => ({
      id: String(a.id),
      name: a.name,
      picture: a.picture_medium || a.picture,
      nb_fan: a.nb_fan,
    })), ['name']);

    res.json({ tracks, albums, artists });
  } catch (e) {
    console.error('[search]', e);
    res.status(500).json({ error: 'search failed' });
  }
});

app.get('/api/track/:id', async (req, res) => {
  try {
    const t = await deezerGet('track', req.params.id);
    if (t.error) return res.status(404).json({ error: t.error.message });
    // список авторов
    const contributors = (t.contributors || []).map(c => ({ id: c.id, name: c.name }));
    res.json({
      id: String(t.id),
      title: t.title,
      artist: t.artist.name,
      artist_id: String(t.artist.id),
      artists: contributors.length ? contributors.map(c => c.name) : [t.artist.name],
      contributors,
      album: t.album.title,
      album_id: String(t.album.id),
      cover: t.album.cover_xl || t.album.cover_big || t.album.cover_medium,
      preview: t.preview,
      duration: t.duration,
      release_date: t.release_date,
      bpm: t.bpm,
      rank: t.rank,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/album/:id', async (req, res) => {
  try {
    const a = await deezerGet('album', req.params.id);
    if (a.error) return res.status(404).json({ error: a.error.message });
    res.json({
      id: String(a.id),
      title: a.title,
      artist: a.artist.name,
      artist_id: String(a.artist.id),
      cover: a.cover_xl || a.cover_big,
      release_date: a.release_date,
      genres: (a.genres && a.genres.data) ? a.genres.data.map(g => g.name) : [],
      label: a.label,
      duration: a.duration,
      nb_tracks: a.nb_tracks,
      tracks: (a.tracks && a.tracks.data) ? a.tracks.data.map(t => ({
        id: String(t.id),
        title: t.title,
        artist: t.artist.name,
        artists: (t.contributors || []).map(c => c.name),
        duration: t.duration,
        preview: t.preview,
      })) : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/artist/:id', async (req, res) => {
  try {
    const a = await deezerGet('artist', req.params.id);
    if (a.error) return res.status(404).json({ error: a.error.message });
    const top = await httpGetJSON(`${DEEZER_BASE}/artist/${req.params.id}/top?limit=15`).catch(() => ({ data: [] }));
    const albums = await httpGetJSON(`${DEEZER_BASE}/artist/${req.params.id}/albums?limit=25`).catch(() => ({ data: [] }));
    res.json({
      id: String(a.id),
      name: a.name,
      picture: a.picture_xl || a.picture_big,
      nb_fan: a.nb_fan,
      top: (top.data || []).map(t => ({
        id: String(t.id), title: t.title, artist: t.artist.name,
        cover: t.album ? t.album.cover_medium : '', preview: t.preview, duration: t.duration,
      })),
      albums: (albums.data || []).map(al => ({
        id: String(al.id), title: al.title, cover: al.cover_medium, release_date: al.release_date,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ YOUTUBE MUSIC STREAM ============
// Ищем на YT по названию + артисту и стримим аудио
app.get('/api/stream', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'no query' });
  try {
    const found = await ytmFindTrack(q);
    if (!found || !found.videoId) return res.status(404).json({ error: 'not found' });
    const videoId = found.videoId;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 });
    stream.on('error', (e) => { console.warn('[ytdl]', e.message); try { res.end(); } catch {} });
    stream.pipe(res);
  } catch (e) {
    console.error('[stream]', e);
    res.status(500).json({ error: e.message });
  }
});

// Возвращает videoId + текст, если удалось найти
app.get('/api/lyrics', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ lines: [], videoId: null });
  try {
    const found = await ytmFindTrack(q);
    if (!found) return res.json({ lines: [], videoId: null });
    let lines = [];
    try {
      await ensureYTM();
      const lyricsBrowseId = await ytm.getLyrics && ytm.getLyrics(found.videoId).catch(() => null);
      // youtube-music-api не всегда возвращает время — делаем псевдо-караоке разбиением
      if (lyricsBrowseId && typeof lyricsBrowseId === 'string') {
        lines = lyricsBrowseId.split(/\n+/).map(t => t.trim()).filter(Boolean).map((text, i) => ({ text, time: i * 3 }));
      }
    } catch {}
    res.json({ videoId: found.videoId, title: found.name, lines });
  } catch (e) {
    res.json({ lines: [], videoId: null });
  }
});

// ============ РЕЦЕНЗИИ И ОЦЕНКИ ============
app.post('/api/review', requireAuth, (req, res) => {
  const { item_type, item_id, item_title, item_artist, item_cover, rhymes, structure, style, charisma, vibe, title, body } = req.body;
  if (!['track', 'album'].includes(item_type)) return res.status(400).json({ error: 'bad type' });
  if (!item_id) return res.status(400).json({ error: 'no item' });
  const clamp = (v) => Math.max(0, Math.min(10, parseInt(v || 0)));
  const r = clamp(rhymes), s = clamp(structure), st = clamp(style), c = clamp(charisma), v = clamp(vibe);
  const total = (r + s + st + c + v) * 2; // 5*10 = 50, шкала 90 — множитель 1.8, но сохраним прямой перевод: 5*10*(90/50)=9*sum
  // Правильно: 5 критериев × 10 баллов = 50, отображаем как /90 → total = sum * 1.8. Округляем.
  const total90 = Math.round((r + s + st + c + v) * 1.8);

  const hasBody = body && body.trim().length >= 300;
  if (hasBody && body.length > 8500) return res.status(400).json({ error: 'too long' });

  db.prepare(`
    INSERT INTO reviews (user_id, item_type, item_id, item_title, item_artist, item_cover, rhymes, structure, style, charisma, vibe, total, title, body)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
      rhymes=excluded.rhymes, structure=excluded.structure, style=excluded.style,
      charisma=excluded.charisma, vibe=excluded.vibe, total=excluded.total,
      title=excluded.title, body=excluded.body, item_title=excluded.item_title,
      item_artist=excluded.item_artist, item_cover=excluded.item_cover,
      created_at=strftime('%s','now')
  `).run(req.session.userId, item_type, String(item_id), item_title || '', item_artist || '', item_cover || '',
    r, s, st, c, v, total90, title || '', hasBody ? body : '');

  res.json({ ok: true, total: total90 });
});

app.delete('/api/review/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

// Все рецензии на объект
app.get('/api/reviews', (req, res) => {
  const { item_type, item_id } = req.query;
  const rows = db.prepare(`
    SELECT r.*, u.telegram_id, u.username, u.first_name, u.last_name, u.photo_url, u.verified
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.item_type = ? AND r.item_id = ?
    ORDER BY r.created_at DESC
  `).all(item_type, String(item_id));
  const avg = rows.length ? rows.reduce((a, r) => a + r.total, 0) / rows.length : null;
  res.json({
    reviews: rows.map(r => ({
      id: r.id, user: publicUser({ id: r.user_id, telegram_id: r.telegram_id, username: r.username, first_name: r.first_name, last_name: r.last_name, photo_url: r.photo_url, verified: r.verified }),
      rhymes: r.rhymes, structure: r.structure, style: r.style, charisma: r.charisma, vibe: r.vibe,
      total: r.total, title: r.title, body: r.body, created_at: r.created_at,
      is_review: r.body && r.body.length >= 300,
    })),
    average: avg,
    count: rows.length,
  });
});

// Моя рецензия на конкретный item
app.get('/api/review/mine', requireAuth, (req, res) => {
  const { item_type, item_id } = req.query;
  const r = db.prepare('SELECT * FROM reviews WHERE user_id=? AND item_type=? AND item_id=?')
    .get(req.session.userId, item_type, String(item_id));
  res.json({ review: r || null });
});

// ============ ИЗБРАННОЕ ============
app.post('/api/favorite', requireAuth, (req, res) => {
  const { item_type, item_id, item_title, item_artist, item_cover } = req.body;
  const existing = db.prepare('SELECT id FROM favorites WHERE user_id=? AND item_type=? AND item_id=?')
    .get(req.session.userId, item_type, String(item_id));
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id=?').run(existing.id);
    return res.json({ ok: true, favorited: false });
  }
  db.prepare('INSERT INTO favorites (user_id, item_type, item_id, item_title, item_artist, item_cover) VALUES (?,?,?,?,?,?)')
    .run(req.session.userId, item_type, String(item_id), item_title || '', item_artist || '', item_cover || '');
  res.json({ ok: true, favorited: true });
});

app.get('/api/favorites', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM favorites WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ favorites: rows });
});

app.get('/api/favorite/check', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id FROM favorites WHERE user_id=? AND item_type=? AND item_id=?')
    .get(req.session.userId, req.query.item_type, String(req.query.item_id));
  res.json({ favorited: !!r });
});

// ============ ТОПЫ / РЕЙТИНГ ============
app.get('/api/top', (req, res) => {
  const type = req.query.type || 'track';
  const period = req.query.period || 'all'; // day | week | month | all
  let since = 0;
  const now = Math.floor(Date.now() / 1000);
  if (period === 'day') since = now - 86400;
  if (period === 'week') since = now - 7 * 86400;
  if (period === 'month') since = now - 30 * 86400;

  const rows = db.prepare(`
    SELECT item_id, item_title, item_artist, item_cover, item_type,
      AVG(total) AS avg_total, COUNT(*) AS cnt
    FROM reviews
    WHERE item_type = ? AND created_at >= ?
    GROUP BY item_id
    ORDER BY avg_total DESC, cnt DESC
    LIMIT 50
  `).all(type, since);
  res.json({ items: rows });
});

// ============ ПРОФИЛЬ ============
app.get('/api/user/:tid', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(req.params.tid);
  if (!u) return res.status(404).json({ error: 'not found' });
  const reviews = db.prepare('SELECT * FROM reviews WHERE user_id=? ORDER BY created_at DESC').all(u.id);
  const favs = db.prepare('SELECT * FROM favorites WHERE user_id=? ORDER BY created_at DESC').all(u.id);
  res.json({ user: publicUser(u), reviews, favorites: favs });
});

// ============ ВЕРИФИКАЦИЯ ============
app.post('/api/verify/request', requireAuth, upload.single('video'), (req, res) => {
  const { socials, comment } = req.body;
  let videoUrl = req.body.video_url || '';
  if (req.file) videoUrl = '/uploads/' + path.basename(req.file.path);
  if (!videoUrl) return res.status(400).json({ error: 'no video' });
  db.prepare('INSERT INTO verify_requests (user_id, video_url, socials, comment) VALUES (?,?,?,?)')
    .run(req.session.userId, videoUrl, socials || '', comment || '');
  db.prepare("UPDATE users SET verify_status='pending' WHERE id=?").run(req.session.userId);
  res.json({ ok: true });
});

// ============ АДМИНКА ============
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const reviews = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;
  const verified = db.prepare('SELECT COUNT(*) c FROM users WHERE verified=1').get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM verify_requests WHERE status='pending'").get().c;
  const recent = db.prepare(`
    SELECT r.*, u.username, u.first_name FROM reviews r
    JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 20
  `).all();
  res.json({ users, reviews, verified, pending, recent });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
  res.json({ users: rows.map(publicUser) });
});

app.post('/api/admin/user/:id/verify', requireAdmin, (req, res) => {
  const { value } = req.body;
  db.prepare("UPDATE users SET verified=?, verify_status=? WHERE id=?")
    .run(value ? 1 : 0, value ? 'approved' : 'none', req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/user/:id/ban', requireAdmin, (req, res) => {
  const { value } = req.body;
  db.prepare('UPDATE users SET is_banned=? WHERE id=?').run(value ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/verify-requests', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT v.*, u.username, u.first_name, u.telegram_id
    FROM verify_requests v JOIN users u ON u.id = v.user_id
    ORDER BY v.created_at DESC
  `).all();
  res.json({ requests: rows });
});

app.post('/api/admin/verify-requests/:id/decision', requireAdmin, (req, res) => {
  const { approved } = req.body;
  const r = db.prepare('SELECT * FROM verify_requests WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE verify_requests SET status=?, reviewed_at=strftime('%s','now') WHERE id=?")
    .run(approved ? 'approved' : 'rejected', r.id);
  db.prepare("UPDATE users SET verified=?, verify_status=? WHERE id=?")
    .run(approved ? 1 : 0, approved ? 'approved' : 'rejected', r.user_id);
  res.json({ ok: true });
});

// Номинации
app.get('/api/nominations', (req, res) => {
  const rows = db.prepare('SELECT * FROM nominations ORDER BY created_at DESC').all();
  res.json({ nominations: rows });
});

app.post('/api/admin/nomination', requireAdmin, (req, res) => {
  const { title, description, bg_color, text_color, accent_color, image } = req.body;
  const info = db.prepare(`INSERT INTO nominations (title, description, bg_color, text_color, accent_color, image) VALUES (?,?,?,?,?,?)`)
    .run(title, description || '', bg_color || '#0f0f14', text_color || '#ffffff', accent_color || '#7c5cff', image || '');
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/admin/nomination/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM nominations WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Генератор картинок номинаций
app.post('/api/admin/nomination/render', requireAdmin, async (req, res) => {
  try {
    const { title = 'Номинация', subtitle = '', winner = '', bg_color = '#0f0f14', text_color = '#ffffff', accent_color = '#7c5cff' } = req.body;
    const W = 1200, H = 675;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    // фон-градиент
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg_color);
    g.addColorStop(1, shade(bg_color, -20));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // сияние
    const glow = ctx.createRadialGradient(W * 0.8, H * 0.2, 20, W * 0.8, H * 0.2, 500);
    glow.addColorStop(0, accent_color + 'aa');
    glow.addColorStop(1, accent_color + '00');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // рамка стекла
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    roundRect(ctx, 60, 60, W - 120, H - 120, 32);
    ctx.stroke();
    // текст
    ctx.fillStyle = accent_color;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('DREINNIFY · НОМИНАЦИЯ', 100, 130);
    ctx.fillStyle = text_color;
    ctx.font = 'bold 78px sans-serif';
    wrapText(ctx, title, 100, 240, W - 200, 88);
    ctx.font = '32px sans-serif';
    ctx.fillStyle = text_color + 'cc';
    wrapText(ctx, subtitle, 100, 420, W - 200, 42);
    if (winner) {
      ctx.font = 'bold 44px sans-serif';
      ctx.fillStyle = accent_color;
      ctx.fillText('★ ' + winner, 100, H - 100);
    }
    const filename = 'nom_' + Date.now() + '.png';
    const outPath = path.join(__dirname, 'public', 'uploads', filename);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
    res.json({ ok: true, url: '/uploads/' + filename });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = (text || '').split(' ');
  let line = '';
  for (const w of words) {
    const test = line + w + ' ';
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w + ' '; y += lineH;
    } else line = test;
  }
  ctx.fillText(line, x, y);
}
function shade(hex, p) {
  const c = hex.replace('#', '');
  const n = parseInt(c, 16);
  let r = (n >> 16) + p, g = ((n >> 8) & 0xff) + p, b = (n & 0xff) + p;
  r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// ============ КРИТЕРИИ 90-балльной ============
app.get('/api/criteria', (req, res) => {
  res.json({
    criteria: [
      { key: 'rhymes', title: 'Рифмы / Образы', desc: 'Оценка сложности рифм, метафор, каламбуров, литературных приёмов, панчей. Насколько ярко автор играет со словом.' },
      { key: 'structure', title: 'Структура / Ритмика', desc: 'Флоу, скорость, попадание в бит, разнообразие подач, схема куплетов и припевов, паузы, дыхание.' },
      { key: 'style', title: 'Реализация стиля', desc: 'Насколько чётко и убедительно артист выполняет заявленную стилистику: атмосфера, звук, подача.' },
      { key: 'charisma', title: 'Индивидуальность / Харизма', desc: 'Уникальность подачи, тембр, узнаваемость, эмоция, актёрская игра голосом.' },
      { key: 'vibe', title: 'Атмосфера / Вайб', desc: 'Общее впечатление, ощущение целостности произведения, послевкусие. Это то ощущение, что остаётся после.' },
    ],
    scale: 'Каждый критерий: 0–10. Итог × 1.8 = /90. Пример: 5+5+5+5+1 = 21 → 21×1.8 ≈ 38. Но в UI показываем сумму × 90/50.',
    verify_criteria: [
      '> 5 000 подписчиков в одной соц. сети (Instagram/YouTube/TikTok/VK/Telegram)',
      'или > 50 000 суммарных прослушиваний артиста на стримингах',
      'или регулярные упоминания в СМИ / профильных медиа',
      'Видео-подтверждение: запись, где вы вслух произносите фразу «Я — <ник>, подтверждаю Dreinnify» с показом лица и своих соц. страниц',
    ]
  });
});

// ============ РОУТИНГ ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/track/:id', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/album/:id', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/artist/:id', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/profile/:tid', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/me', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/top', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/verify', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));

app.get('/api/config', (req, res) => {
  res.json({ domain: DOMAIN, bot_username: BOT_USERNAME });
});

app.listen(PORT, () => {
  console.log(`🎧 Dreinnify запущен на ${DOMAIN} (порт ${PORT})`);
  console.log(`👤 Admin Telegram ID: ${ADMIN_ID || '(не задан)'}`);
});

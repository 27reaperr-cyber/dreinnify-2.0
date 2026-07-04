/*
 * Dreinnify — сервер и Telegram-бот в одном файле.
 * Всё бэкенд-состояние живёт здесь: HTTP-API, авторизация через бота,
 * SQLite, поиск в Deezer, стриминг с YouTube Music, генератор картинок номинаций.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const ytdl = require('@distube/ytdl-core');
const YouTube = require('youtube-sr').default;
const { createCanvas, loadImage, registerFont } = require('canvas');

// ---------- env ----------
const {
  PORT = 3000,
  DOMAIN = `http://localhost:${PORT}`,
  SESSION_SECRET = 'dev-secret-change-me',
  BOT_TOKEN,
  BOT_USERNAME,
  ADMIN_ID,
  TRUST_PROXY = '0',
} = process.env;

if (!BOT_TOKEN || !BOT_USERNAME || !ADMIN_ID) {
  console.warn('[warn] BOT_TOKEN / BOT_USERNAME / ADMIN_ID не установлены — авторизация не заработает.');
}
const ADMIN_TG_ID = String(ADMIN_ID || '');

// ---------- пути ----------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'generated');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// ============================================================
// БД
// ============================================================
const db = new Database(path.join(DATA_DIR, 'dreinnify.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         TEXT UNIQUE NOT NULL,
  username      TEXT,
  first_name    TEXT,
  last_name     TEXT,
  photo_url     TEXT,
  bio           TEXT DEFAULT '',
  verified      INTEGER DEFAULT 0,           -- 0/1
  verified_note TEXT DEFAULT '',
  is_admin      INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_requests (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at INTEGER
);

-- Кэш метаданных Deezer, чтобы уменьшить запросы
CREATE TABLE IF NOT EXISTS tracks_cache (
  deezer_id   INTEGER PRIMARY KEY,
  data_json   TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS albums_cache (
  deezer_id   INTEGER PRIMARY KEY,
  data_json   TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,   -- 'track' | 'album'
  target_id    INTEGER NOT NULL,
  s_rhymes     INTEGER NOT NULL,  -- 0..18
  s_structure  INTEGER NOT NULL,
  s_style      INTEGER NOT NULL,
  s_identity   INTEGER NOT NULL,
  s_vibe       INTEGER NOT NULL,
  total        INTEGER NOT NULL,  -- 0..90
  title        TEXT DEFAULT '',
  body         TEXT DEFAULT '',   -- '' если оценка без рецензии
  has_text     INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_target ON reviews(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS nominations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  image_url    TEXT DEFAULT '',
  color        TEXT DEFAULT '#7ea4ff',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  socials_json TEXT NOT NULL,
  video_url    TEXT NOT NULL,
  comment      TEXT DEFAULT '',
  status       TEXT DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  review_note  TEXT DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`);

const q = {
  userByTgId: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`INSERT INTO users(tg_id, username, first_name, last_name, photo_url, is_admin, created_at)
                          VALUES(?, ?, ?, ?, ?, ?, ?)`),
  updateUserTg: db.prepare(`UPDATE users SET username=?, first_name=?, last_name=?, photo_url=? WHERE id=?`),
  updateProfile: db.prepare(`UPDATE users SET bio=? WHERE id=?`),
  setVerified: db.prepare(`UPDATE users SET verified=?, verified_note=? WHERE id=?`),

  insertSession: db.prepare(`INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)`),
  sessionByToken: db.prepare(`SELECT s.*, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token = ? AND s.expires_at > ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  insertAuthReq: db.prepare(`INSERT INTO auth_requests(code, created_at) VALUES(?, ?)`),
  approveAuthReq: db.prepare(`UPDATE auth_requests SET user_id=?, approved_at=? WHERE code=?`),
  authReq: db.prepare(`SELECT * FROM auth_requests WHERE code = ?`),
  cleanupAuthReq: db.prepare(`DELETE FROM auth_requests WHERE created_at < ?`),

  cacheTrackGet: db.prepare(`SELECT data_json, fetched_at FROM tracks_cache WHERE deezer_id = ?`),
  cacheTrackPut: db.prepare(`INSERT OR REPLACE INTO tracks_cache(deezer_id, data_json, fetched_at) VALUES(?, ?, ?)`),
  cacheAlbumGet: db.prepare(`SELECT data_json, fetched_at FROM albums_cache WHERE deezer_id = ?`),
  cacheAlbumPut: db.prepare(`INSERT OR REPLACE INTO albums_cache(deezer_id, data_json, fetched_at) VALUES(?, ?, ?)`),

  upsertReview: db.prepare(`
    INSERT INTO reviews(user_id, target_type, target_id, s_rhymes, s_structure, s_style, s_identity, s_vibe,
                        total, title, body, has_text, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET
      s_rhymes=excluded.s_rhymes, s_structure=excluded.s_structure, s_style=excluded.s_style,
      s_identity=excluded.s_identity, s_vibe=excluded.s_vibe, total=excluded.total,
      title=excluded.title, body=excluded.body, has_text=excluded.has_text,
      updated_at=excluded.updated_at`),
  reviewsForTarget: db.prepare(`
    SELECT r.*, u.username, u.first_name, u.verified, u.tg_id
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.target_type = ? AND r.target_id = ?
    ORDER BY r.updated_at DESC`),
  reviewsByUser: db.prepare(`SELECT * FROM reviews WHERE user_id = ? ORDER BY updated_at DESC`),
  avgForTarget: db.prepare(`SELECT AVG(total) AS avg, COUNT(*) AS cnt FROM reviews WHERE target_type=? AND target_id=?`),
  deleteReview: db.prepare(`DELETE FROM reviews WHERE id = ?`),

  addFavorite: db.prepare(`INSERT OR IGNORE INTO favorites(user_id, target_type, target_id, added_at) VALUES(?, ?, ?, ?)`),
  removeFavorite: db.prepare(`DELETE FROM favorites WHERE user_id=? AND target_type=? AND target_id=?`),
  favoritesByUser: db.prepare(`SELECT * FROM favorites WHERE user_id=? ORDER BY added_at DESC`),
  isFavorite: db.prepare(`SELECT 1 FROM favorites WHERE user_id=? AND target_type=? AND target_id=?`),

  insertNomination: db.prepare(`INSERT INTO nominations(title, description, image_url, color, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?)`),
  updateNomination: db.prepare(`UPDATE nominations SET title=?, description=?, image_url=?, color=? WHERE id=?`),
  deleteNomination: db.prepare(`DELETE FROM nominations WHERE id=?`),
  listNominations: db.prepare(`SELECT * FROM nominations ORDER BY created_at DESC`),

  insertVerifyReq: db.prepare(`INSERT INTO verification_requests(user_id, socials_json, video_url, comment, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)`),
  verifyReqByUser: db.prepare(`SELECT * FROM verification_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 1`),
  listVerifyReqs: db.prepare(`SELECT vr.*, u.username, u.first_name, u.tg_id FROM verification_requests vr JOIN users u ON u.id = vr.user_id WHERE vr.status='pending' ORDER BY vr.created_at DESC`),
  updateVerifyReq: db.prepare(`UPDATE verification_requests SET status=?, reviewed_by=?, review_note=?, updated_at=? WHERE id=?`),
  verifyReqById: db.prepare(`SELECT * FROM verification_requests WHERE id=?`),

  countUsers: db.prepare(`SELECT COUNT(*) AS c FROM users`),
  countReviews: db.prepare(`SELECT COUNT(*) AS c FROM reviews`),
  countVerified: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE verified=1`),
  listAllUsers: db.prepare(`SELECT id, tg_id, username, first_name, verified, is_admin, created_at FROM users ORDER BY created_at DESC LIMIT 500`),
};

// ============================================================
// Утилиты
// ============================================================
const now = () => Date.now();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const AUTH_REQ_TTL = 15 * 60 * 1000;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function randToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function ensureUser(tgUser) {
  const tgId = String(tgUser.id);
  let user = q.userByTgId.get(tgId);
  const isAdmin = tgId === ADMIN_TG_ID ? 1 : 0;
  if (!user) {
    const info = q.insertUser.run(
      tgId,
      tgUser.username || null,
      tgUser.first_name || null,
      tgUser.last_name || null,
      tgUser.photo_url || null,
      isAdmin,
      now(),
    );
    user = q.userById.get(info.lastInsertRowid);
  } else {
    q.updateUserTg.run(tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || user.photo_url || null, user.id);
    if (user.is_admin !== isAdmin) {
      db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(isAdmin, user.id);
    }
    user = q.userById.get(user.id);
  }
  return user;
}

function createSession(userId) {
  const token = randToken(32);
  q.insertSession.run(token, userId, now(), now() + SESSION_TTL);
  return token;
}

// ============================================================
// Telegram bot — авторизация через deep-link
// ============================================================
let bot = null;
if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.on('polling_error', (e) => console.error('[bot] polling', e.message));

  bot.onText(/^\/start(?:\s+(\S+))?/, async (msg, match) => {
    const code = match?.[1];
    const tg = msg.from;
    const user = ensureUser(tg);

    if (!code) {
      return bot.sendMessage(msg.chat.id,
        `👋 Привет, ${tg.first_name || 'друг'}!\n\nЭто бот авторизации Dreinnify — платформы рецензий на музыку.\nОткрой ${DOMAIN} и нажми «Войти через Telegram», сюда придёт кнопка подтверждения.`);
    }

    const req = q.authReq.get(code);
    if (!req) {
      return bot.sendMessage(msg.chat.id, '⚠️ Код авторизации не найден или истёк. Попробуй заново на сайте.');
    }
    if (now() - req.created_at > AUTH_REQ_TTL) {
      return bot.sendMessage(msg.chat.id, '⚠️ Код устарел (лимит 15 минут). Запроси новый.');
    }

    await bot.sendMessage(msg.chat.id, `🔐 Подтвердить вход на *${new URL(DOMAIN).host}*?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Войти', callback_data: `auth_ok:${code}` },
          { text: '❌ Отмена', callback_data: `auth_no:${code}` },
        ]],
      },
    });
  });

  bot.on('callback_query', async (cbq) => {
    const [action, code] = (cbq.data || '').split(':');
    const tg = cbq.from;
    const req = q.authReq.get(code);
    if (!req) return bot.answerCallbackQuery(cbq.id, { text: 'Код не найден' });
    if (now() - req.created_at > AUTH_REQ_TTL) return bot.answerCallbackQuery(cbq.id, { text: 'Код устарел' });

    if (action === 'auth_no') {
      db.prepare('DELETE FROM auth_requests WHERE code=?').run(code);
      await bot.answerCallbackQuery(cbq.id, { text: 'Отменено' });
      return bot.editMessageText('❌ Вход отменён.', { chat_id: cbq.message.chat.id, message_id: cbq.message.message_id });
    }
    if (action === 'auth_ok') {
      const user = ensureUser(tg);
      q.approveAuthReq.run(user.id, now(), code);
      await bot.answerCallbackQuery(cbq.id, { text: 'Готово, возвращайся на сайт' });
      return bot.editMessageText('✅ Вход подтверждён. Возвращайся на сайт — он подхватит сессию автоматически.',
        { chat_id: cbq.message.chat.id, message_id: cbq.message.message_id });
    }
  });

  console.log('[bot] запущен, username:', BOT_USERNAME);
}

// Периодическая очистка старых кодов
setInterval(() => q.cleanupAuthReq.run(now() - AUTH_REQ_TTL), 5 * 60 * 1000).unref();

// ============================================================
// Express app
// ============================================================
const app = express();
if (TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(SESSION_SECRET));

app.use('/static', express.static(PUBLIC_DIR, { maxAge: '1h' }));
app.use('/generated', express.static(GENERATED_DIR, { maxAge: '7d' }));

// --- middleware auth ---
function readUser(req) {
  const token = req.signedCookies?.sid || req.cookies?.sid;
  if (!token) return null;
  const row = q.sessionByToken.get(token, now());
  return row || null;
}
function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  if (!u.is_admin && String(u.tg_id) !== ADMIN_TG_ID) return res.status(403).json({ error: 'forbidden' });
  req.user = u;
  next();
}

// ============================================================
// AUTH endpoints
// ============================================================
app.post('/api/auth/start', (req, res) => {
  const code = randToken(10);
  q.insertAuthReq.run(code, now());
  const url = `https://t.me/${BOT_USERNAME}?start=${code}`;
  res.json({ code, url, expiresIn: AUTH_REQ_TTL });
});

app.get('/api/auth/poll', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code required' });
  const row = q.authReq.get(code);
  if (!row) return res.status(404).json({ status: 'unknown' });
  if (!row.approved_at) return res.json({ status: 'pending' });
  const token = createSession(row.user_id);
  db.prepare('DELETE FROM auth_requests WHERE code=?').run(code);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', signed: true,
    maxAge: SESSION_TTL, secure: DOMAIN.startsWith('https'),
  });
  res.json({ status: 'ok' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.signedCookies?.sid || req.cookies?.sid;
  if (token) q.deleteSession.run(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = readUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: publicUser(u), isAdmin: !!u.is_admin });
});

function publicUser(u) {
  return {
    id: u.user_id || u.id,
    tgId: u.tg_id,
    username: u.username,
    firstName: u.first_name,
    lastName: u.last_name,
    photoUrl: u.photo_url,
    bio: u.bio || '',
    verified: !!u.verified,
    verifiedNote: u.verified_note || '',
    isAdmin: !!u.is_admin,
  };
}

// ============================================================
// Deezer API — поиск, треки, альбомы, тексты (через lyrics.ovh)
// ============================================================
const DEEZER = 'https://api.deezer.com';

async function deezerGet(pathq) {
  const r = await fetch(`${DEEZER}${pathq}`, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error('deezer ' + r.status);
  return r.json();
}

async function getTrack(id) {
  const cached = q.cacheTrackGet.get(id);
  if (cached && now() - cached.fetched_at < CACHE_TTL) return JSON.parse(cached.data_json);
  const data = await deezerGet(`/track/${id}`);
  q.cacheTrackPut.run(id, JSON.stringify(data), now());
  return data;
}
async function getAlbum(id) {
  const cached = q.cacheAlbumGet.get(id);
  if (cached && now() - cached.fetched_at < CACHE_TTL) return JSON.parse(cached.data_json);
  const data = await deezerGet(`/album/${id}`);
  q.cacheAlbumPut.run(id, JSON.stringify(data), now());
  return data;
}

// Формат трека для клиента
function shapeTrack(t) {
  return {
    id: t.id,
    title: t.title,
    titleShort: t.title_short,
    duration: t.duration,
    preview: t.preview,
    explicit: !!t.explicit_lyrics,
    artist: t.artist ? { id: t.artist.id, name: t.artist.name, picture: t.artist.picture_medium } : null,
    contributors: (t.contributors || []).map(a => ({ id: a.id, name: a.name })),
    album: t.album ? { id: t.album.id, title: t.album.title, cover: t.album.cover_medium || t.album.cover } : null,
    rank: t.rank,
  };
}
function shapeAlbum(a) {
  return {
    id: a.id,
    title: a.title,
    cover: a.cover_xl || a.cover_big || a.cover_medium,
    artist: a.artist ? { id: a.artist.id, name: a.artist.name, picture: a.artist.picture_medium } : null,
    releaseDate: a.release_date,
    duration: a.duration,
    nbTracks: a.nb_tracks,
    tracks: (a.tracks?.data || []).map(shapeTrack),
    genres: (a.genres?.data || []).map(g => g.name),
  };
}

app.get('/api/search', async (req, res) => {
  const { q: query = '', limit = 30 } = req.query;
  if (!query.trim()) return res.json({ tracks: [], albums: [], artists: [] });
  try {
    // Русскоязычная музыка в приоритете: сначала ищем без фильтров (Deezer ранжирует по релевантности),
    // потом переупорядочиваем — треки с кириллицей в названии или у артиста выше.
    const [tr, al, ar] = await Promise.all([
      deezerGet(`/search/track?q=${encodeURIComponent(query)}&limit=${limit}`),
      deezerGet(`/search/album?q=${encodeURIComponent(query)}&limit=${Math.max(10, +limit / 2)}`),
      deezerGet(`/search/artist?q=${encodeURIComponent(query)}&limit=10`),
    ]);
    const isCyr = s => /[а-яё]/i.test(s || '');
    const rank = (a, b) => {
      const ac = (isCyr(a.title) || isCyr(a.artist?.name)) ? 1 : 0;
      const bc = (isCyr(b.title) || isCyr(b.artist?.name)) ? 1 : 0;
      return bc - ac;
    };
    res.json({
      tracks: (tr.data || []).sort(rank).map(shapeTrack),
      albums: (al.data || []).sort((a, b) => {
        const ac = isCyr(a.title) || isCyr(a.artist?.name) ? 1 : 0;
        const bc = isCyr(b.title) || isCyr(b.artist?.name) ? 1 : 0;
        return bc - ac;
      }).map(a => ({
        id: a.id, title: a.title, cover: a.cover_medium || a.cover,
        artist: a.artist ? { id: a.artist.id, name: a.artist.name } : null,
        nbTracks: a.nb_tracks,
      })),
      artists: (ar.data || []).map(a => ({ id: a.id, name: a.name, picture: a.picture_medium, nbAlbum: a.nb_album })),
    });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(502).json({ error: 'search failed' });
  }
});

app.get('/api/track/:id', async (req, res) => {
  try {
    const t = await getTrack(req.params.id);
    const shaped = shapeTrack(t);
    const avg = q.avgForTarget.get('track', t.id);
    const reviews = q.reviewsForTarget.all('track', t.id).map(shapeReview);
    res.json({ track: shaped, rating: { avg: avg.avg ? +avg.avg.toFixed(1) : null, count: avg.cnt }, reviews });
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

app.get('/api/album/:id', async (req, res) => {
  try {
    const a = await getAlbum(req.params.id);
    const shaped = shapeAlbum(a);
    const avg = q.avgForTarget.get('album', a.id);
    const reviews = q.reviewsForTarget.all('album', a.id).map(shapeReview);
    res.json({ album: shaped, rating: { avg: avg.avg ? +avg.avg.toFixed(1) : null, count: avg.cnt }, reviews });
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

app.get('/api/artist/:id', async (req, res) => {
  try {
    const info = await deezerGet(`/artist/${req.params.id}`);
    const top = await deezerGet(`/artist/${req.params.id}/top?limit=20`);
    const albs = await deezerGet(`/artist/${req.params.id}/albums?limit=25`);
    res.json({
      artist: { id: info.id, name: info.name, picture: info.picture_xl || info.picture_big, nbFan: info.nb_fan, nbAlbum: info.nb_album },
      top: (top.data || []).map(shapeTrack),
      albums: (albs.data || []).map(a => ({ id: a.id, title: a.title, cover: a.cover_medium, releaseDate: a.release_date })),
    });
  } catch (e) {
    res.status(404).json({ error: 'not found' });
  }
});

// Синхронизированный текст. Deezer не отдаёт LRC свободно.
// Пробуем: 1) lyrics.ovh (обычный текст) — построчно с равномерным таймингом;
// в реальном проекте сюда легко подставить lrclib.net или Musixmatch.
app.get('/api/track/:id/lyrics', async (req, res) => {
  try {
    const t = await getTrack(req.params.id);
    const artist = t.artist?.name || '';
    const title = t.title || '';
    // lrclib.net — открытая база синхронизированных текстов
    try {
      const r = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${t.duration}`);
      if (r.ok) {
        const data = await r.json();
        if (data.syncedLyrics) {
          return res.json({ synced: parseLRC(data.syncedLyrics), plain: data.plainLyrics || '' });
        }
        if (data.plainLyrics) {
          return res.json({ synced: null, plain: data.plainLyrics });
        }
      }
    } catch {}
    // fallback: lyrics.ovh (только plain)
    try {
      const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
      if (r.ok) {
        const data = await r.json();
        return res.json({ synced: null, plain: data.lyrics || '' });
      }
    } catch {}
    res.json({ synced: null, plain: '' });
  } catch (e) {
    res.json({ synced: null, plain: '' });
  }
});

function parseLRC(text) {
  const lines = text.split('\n');
  const out = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      const t = (+m[1]) * 60 + parseFloat(m[2]);
      out.push({ t, text: m[3].trim() });
    }
  }
  return out;
}

// ============================================================
// YouTube Music стриминг
// ============================================================
const streamCache = new Map(); // trackId -> { url, expires }

app.get('/api/stream/:trackId', async (req, res) => {
  const id = req.params.trackId;
  try {
    const t = await getTrack(id);
    const query = `${t.artist?.name || ''} ${t.title}`.trim();
    // ищем в YouTube лучший вариант (song)
    const results = await YouTube.search(query, { limit: 5, type: 'video' });
    if (!results.length) return res.status(404).json({ error: 'no youtube result' });
    const chosen = results[0];
    res.json({ videoId: chosen.id, title: chosen.title, duration: chosen.duration, url: `/api/stream/audio/${chosen.id}` });
  } catch (e) {
    console.error('[stream]', e.message);
    res.status(502).json({ error: 'stream failed' });
  }
});

app.get('/api/stream/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
    if (!format) return res.status(404).end();
    res.setHeader('Content-Type', format.mimeType?.split(';')[0] || 'audio/webm');
    res.setHeader('Accept-Ranges', 'bytes');
    const stream = ytdl.downloadFromInfo(info, { format });
    stream.on('error', (e) => { console.error('[ytdl]', e.message); if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (e) {
    console.error('[stream/audio]', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'audio failed' });
  }
});

// ============================================================
// Рецензии/оценки
// ============================================================
const CRIT_MAX = 18;
const CRIT_KEYS = ['s_rhymes', 's_structure', 's_style', 's_identity', 's_vibe'];

function clampScore(v) { v = Math.round(+v || 0); return Math.max(0, Math.min(CRIT_MAX, v)); }

function shapeReview(r) {
  return {
    id: r.id,
    userId: r.user_id,
    author: {
      id: r.user_id,
      username: r.username,
      firstName: r.first_name,
      verified: !!r.verified,
      tgId: r.tg_id,
    },
    targetType: r.target_type,
    targetId: r.target_id,
    scores: {
      rhymes: r.s_rhymes, structure: r.s_structure, style: r.s_style,
      identity: r.s_identity, vibe: r.s_vibe,
    },
    total: r.total,
    title: r.title,
    body: r.body,
    hasText: !!r.has_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.post('/api/review', requireAuth, (req, res) => {
  const { targetType, targetId, scores = {}, title = '', body = '', mode = 'review' } = req.body || {};
  if (!['track', 'album'].includes(targetType)) return res.status(400).json({ error: 'bad targetType' });
  if (!Number.isInteger(+targetId)) return res.status(400).json({ error: 'bad targetId' });
  const s = {
    rhymes: clampScore(scores.rhymes),
    structure: clampScore(scores.structure),
    style: clampScore(scores.style),
    identity: clampScore(scores.identity),
    vibe: clampScore(scores.vibe),
  };
  const total = s.rhymes + s.structure + s.style + s.identity + s.vibe;
  const hasText = mode === 'review' ? 1 : 0;
  if (hasText) {
    const len = (body || '').trim().length;
    if (len < 300 || len > 8500) return res.status(400).json({ error: 'body must be 300..8500 chars' });
  }
  q.upsertReview.run(
    req.user.user_id || req.user.id,
    targetType, +targetId,
    s.rhymes, s.structure, s.style, s.identity, s.vibe, total,
    hasText ? (title || '').slice(0, 160) : '',
    hasText ? body : '',
    hasText,
    now(), now(),
  );
  res.json({ ok: true, total });
});

app.delete('/api/review/:id', requireAuth, (req, res) => {
  const rev = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'not found' });
  if (rev.user_id !== (req.user.user_id || req.user.id) && !req.user.is_admin) return res.status(403).json({ error: 'forbidden' });
  q.deleteReview.run(rev.id);
  res.json({ ok: true });
});

// ============================================================
// Избранное
// ============================================================
app.post('/api/favorite', requireAuth, (req, res) => {
  const { targetType, targetId } = req.body || {};
  if (!['track', 'album'].includes(targetType)) return res.status(400).json({ error: 'bad targetType' });
  q.addFavorite.run(req.user.user_id || req.user.id, targetType, +targetId, now());
  res.json({ ok: true });
});
app.delete('/api/favorite', requireAuth, (req, res) => {
  const { targetType, targetId } = req.body || {};
  q.removeFavorite.run(req.user.user_id || req.user.id, targetType, +targetId);
  res.json({ ok: true });
});
app.get('/api/favorites', requireAuth, async (req, res) => {
  const uid = req.user.user_id || req.user.id;
  const rows = q.favoritesByUser.all(uid);
  const tracks = [], albums = [];
  for (const r of rows) {
    try {
      if (r.target_type === 'track') tracks.push(shapeTrack(await getTrack(r.target_id)));
      else albums.push({ id: r.target_id, ...shapeAlbum(await getAlbum(r.target_id)) });
    } catch {}
  }
  res.json({ tracks, albums });
});

// ============================================================
// Профиль
// ============================================================
app.get('/api/profile/:tgId', (req, res) => {
  const u = q.userByTgId.get(req.params.tgId);
  if (!u) return res.status(404).json({ error: 'not found' });
  const reviews = q.reviewsByUser.all(u.id).slice(0, 100);
  res.json({ user: publicUser(u), reviews });
});

app.post('/api/profile/bio', requireAuth, (req, res) => {
  const bio = (req.body?.bio || '').slice(0, 500);
  q.updateProfile.run(bio, req.user.user_id || req.user.id);
  res.json({ ok: true });
});

// ============================================================
// Верификация: пользователь подаёт заявку
// Критерии (описываются в UI):
//   • ≥ 1000 подписчиков хотя бы в одной соцсети (VK, YouTube, Telegram-канал, Instagram, TikTok, Spotify Artist)
//   • публично доступный музыкальный контент (треки/клипы)
//   • видео-подтверждение: артист лично произносит фразу
//     «Dreinnify, {никнейм}, {код}» — код выдаётся при подаче заявки
//   • отсутствие деструктивного/незаконного контента
// ============================================================
app.post('/api/verify/request', requireAuth, (req, res) => {
  const { socials = [], videoUrl = '', comment = '' } = req.body || {};
  if (!Array.isArray(socials) || socials.length === 0) return res.status(400).json({ error: 'нужна хотя бы одна соцсеть' });
  if (!/^https?:\/\//i.test(videoUrl)) return res.status(400).json({ error: 'нужна ссылка на видео' });
  const uid = req.user.user_id || req.user.id;
  q.insertVerifyReq.run(uid, JSON.stringify(socials), videoUrl, comment.slice(0, 500), now(), now());
  res.json({ ok: true, code: `V-${uid}-${Date.now().toString(36)}` });
});
app.get('/api/verify/mine', requireAuth, (req, res) => {
  const uid = req.user.user_id || req.user.id;
  const row = q.verifyReqByUser.get(uid);
  res.json({ request: row || null });
});

// ============================================================
// Админ панель
// ============================================================
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    users: q.countUsers.get().c,
    reviews: q.countReviews.get().c,
    verified: q.countVerified.get().c,
    pendingVerify: db.prepare(`SELECT COUNT(*) AS c FROM verification_requests WHERE status='pending'`).get().c,
    nominations: db.prepare(`SELECT COUNT(*) AS c FROM nominations`).get().c,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: q.listAllUsers.all() });
});

app.post('/api/admin/verify-toggle', requireAdmin, (req, res) => {
  const { userId, verified, note = '' } = req.body || {};
  q.setVerified.run(verified ? 1 : 0, note.slice(0, 200), +userId);
  res.json({ ok: true });
});

app.get('/api/admin/verify-requests', requireAdmin, (req, res) => {
  res.json({ requests: q.listVerifyReqs.all() });
});
app.post('/api/admin/verify-decide', requireAdmin, (req, res) => {
  const { id, decision, note = '' } = req.body || {};
  const vr = q.verifyReqById.get(+id);
  if (!vr) return res.status(404).json({ error: 'not found' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  q.updateVerifyReq.run(status, req.user.user_id || req.user.id, note.slice(0, 200), now(), vr.id);
  if (status === 'approved') q.setVerified.run(1, 'верифицирован админом', vr.user_id);
  res.json({ ok: true });
});

// -------- Номинации --------
app.get('/api/nominations', (req, res) => res.json({ nominations: q.listNominations.all() }));

app.post('/api/admin/nomination', requireAdmin, (req, res) => {
  const { title, description = '', imageUrl = '', color = '#7ea4ff' } = req.body || {};
  if (!title || title.length > 120) return res.status(400).json({ error: 'title required' });
  const info = q.insertNomination.run(title, description.slice(0, 500), imageUrl, color, req.user.user_id || req.user.id, now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.patch('/api/admin/nomination/:id', requireAdmin, (req, res) => {
  const { title, description = '', imageUrl = '', color = '#7ea4ff' } = req.body || {};
  q.updateNomination.run(title, description, imageUrl, color, +req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/nomination/:id', requireAdmin, (req, res) => {
  q.deleteNomination.run(+req.params.id);
  res.json({ ok: true });
});

// -------- Генератор картинок номинаций (canvas) --------
// POST { title, subtitle, color, gradient?: 'auto'|'#hex' }
// Возвращает PNG в /generated/nomination-*.png
app.post('/api/admin/nomination/generate', requireAdmin, async (req, res) => {
  const { title = 'Номинация', subtitle = '', color = '#7ea4ff', accent = '#c47bff' } = req.body || {};
  try {
    const W = 1200, H = 675;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    // фон-градиент
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b0c10');
    g.addColorStop(1, '#151824');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // подсветка «жидкое стекло»
    const glow1 = ctx.createRadialGradient(W * 0.2, H * 0.35, 0, W * 0.2, H * 0.35, 500);
    glow1.addColorStop(0, hexA(color, 0.55));
    glow1.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, W, H);

    const glow2 = ctx.createRadialGradient(W * 0.8, H * 0.75, 0, W * 0.8, H * 0.75, 480);
    glow2.addColorStop(0, hexA(accent, 0.5));
    glow2.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, W, H);

    // стеклянная карточка по центру
    roundRect(ctx, 80, 130, W - 160, H - 260, 32);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 28px "Manrope", sans-serif';
    ctx.fillText('DREINNIFY · НОМИНАЦИЯ', 120, 200);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 72px "Unbounded", sans-serif';
    wrapText(ctx, title, 120, 300, W - 240, 76);

    if (subtitle) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '28px "Manrope", sans-serif';
      wrapText(ctx, subtitle, 120, H - 200, W - 240, 34);
    }

    const filename = `nomination-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
    const filepath = path.join(GENERATED_DIR, filename);
    fs.writeFileSync(filepath, canvas.toBuffer('image/png'));
    res.json({ ok: true, url: `/generated/${filename}` });
  } catch (e) {
    console.error('[gen]', e);
    res.status(500).json({ error: e.message });
  }
});

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(/\s+/);
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

// ============================================================
// SPA fallback
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[web] Dreinnify запущен на порту ${PORT}, домен: ${DOMAIN}`);
});

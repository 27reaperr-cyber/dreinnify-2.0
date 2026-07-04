/* =============================================================
   Dreinnify — фронтенд SPA
   ============================================================= */
'use strict';

// ---------------- helpers ----------------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) n.setAttribute(k, '');
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
};
const api = async (url, opts = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(data?.error || 'request failed'), { data, status: r.status });
  return data;
};
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const toast = (msg) => {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// ---------------- state ----------------
const state = {
  me: null,
  isAdmin: false,
  queue: [],
  qIndex: 0,
  playing: false,
  lyrics: null,
  currentTrackId: null,
};

// ---------------- auth ----------------
async function loadMe() {
  const { user, isAdmin } = await api('/api/me');
  state.me = user;
  state.isAdmin = !!isAdmin;
  renderMe();
}
function renderMe() {
  const btnLogin = $('#btn-login');
  const btnMe = $('#btn-me');
  const adminLink = $('[data-admin-only]');
  const authOnly = $$('[data-auth]');
  if (state.me) {
    btnLogin.hidden = true;
    btnMe.hidden = false;
    $('#me-name').textContent = state.me.username ? '@' + state.me.username : (state.me.firstName || 'Профиль');
    $('#me-verified').hidden = !state.me.verified;
    const av = $('#me-avatar');
    if (state.me.photoUrl) { av.src = state.me.photoUrl; av.style.display = ''; }
    else av.style.display = 'none';
    if (state.isAdmin) adminLink.hidden = false;
    authOnly.forEach(a => a.hidden = false);
  } else {
    btnLogin.hidden = false;
    btnMe.hidden = true;
    adminLink.hidden = true;
    authOnly.forEach(a => a.hidden = true);
  }
}

$('#btn-login').addEventListener('click', async () => {
  const modal = $('#modal-login');
  modal.hidden = false;
  const status = $('#login-status');
  status.textContent = 'Ожидание подтверждения…';
  try {
    const { url, code } = await api('/api/auth/start', { method: 'POST' });
    $('#login-link').href = url;
    // ждём подтверждения
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000 && !modal.hidden) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const p = await api(`/api/auth/poll?code=${code}`);
        if (p.status === 'ok') {
          status.textContent = 'Успешно! Загружаемся…';
          await loadMe();
          modal.hidden = true;
          break;
        }
      } catch {}
    }
  } catch (e) {
    status.textContent = 'Ошибка: ' + e.message;
  }
});

$('#btn-me').addEventListener('click', (e) => {
  e.stopPropagation();
  openProfileMenu(e.currentTarget);
});

function openProfileMenu(anchor) {
  closeProfileMenu();
  const menu = el('div', { class: 'profile-menu glass', id: 'profile-menu-pop' },
    el('button', { onclick: () => { location.hash = '#/profile'; closeProfileMenu(); } }, 'Мой профиль'),
    el('button', { onclick: () => { location.hash = '#/favorites'; closeProfileMenu(); } }, 'Избранное'),
    el('button', { onclick: () => { openVerifyModal(); closeProfileMenu(); } }, 'Верификация'),
    state.isAdmin ? el('button', { onclick: () => { location.hash = '#/admin'; closeProfileMenu(); } }, 'Админ панель') : null,
    el('hr'),
    el('button', { class: 'danger', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); state.me = null; renderMe(); closeProfileMenu(); location.hash = '#/'; } }, 'Выйти'),
  );
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, {
    position: 'fixed',
    top: (r.bottom + 8) + 'px',
    right: (window.innerWidth - r.right) + 'px',
    zIndex: 60,
  });
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', closeProfileMenu, { once: true }), 0);
}
function closeProfileMenu() { $('#profile-menu-pop')?.remove(); }

// modal closers
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) e.target.closest('.modal').hidden = true;
});

// ---------------- nav scroll animation ----------------
const nav = $('#topnav');
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    const shouldExpand = window.scrollY < 40;
    nav.classList.toggle('nav-collapsed', shouldExpand);
    scrollTicking = false;
  });
}, { passive: true });
// Инициализация: сверху — свёрнутый только логотип (по промпту)
// Тут инверсия: "в начале — логотип текстом Dreinnify, скролим — раскрывается меню"
nav.classList.add('nav-collapsed');
window.addEventListener('scroll', () => {
  const collapse = window.scrollY < 40;
  nav.classList.toggle('nav-collapsed', collapse);
}, { passive: true });

// ---------------- router ----------------
const views = {
  '/': () => renderHome(),
  '/search': () => renderSearchView(),
  '/nominations': () => renderNominations(),
  '/profile': () => renderProfile(state.me?.tgId),
  '/favorites': () => renderFavorites(),
  '/admin': () => renderAdmin(),
};
function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, ...rest] = hash.split('/').filter(Boolean);
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + '/' + (path || '')));
  $$('.view').forEach(v => (v.hidden = true));

  if (hash.startsWith('/track/')) {
    return renderTrack(hash.split('/')[2]);
  }
  if (hash.startsWith('/album/')) {
    return renderAlbum(hash.split('/')[2]);
  }
  if (hash.startsWith('/artist/')) {
    return renderArtist(hash.split('/')[2]);
  }
  if (hash.startsWith('/profile/')) {
    return renderProfile(hash.split('/')[2]);
  }
  const key = '/' + (path || '');
  (views[key] || views['/'])();
}
window.addEventListener('hashchange', route);

// ---------------- home ----------------
async function renderHome() {
  $('#view-home').hidden = false;
  const feed = $('#home-feed');
  feed.innerHTML = '<div class="section-title">Популярное</div>';
  // Простой стартовый плейлист — русские хиты через Deezer chart-подобный запрос
  try {
    const data = await api('/api/search?q=' + encodeURIComponent('русский рэп') + '&limit=20');
    feed.appendChild(renderTracksGrid(data.tracks));
  } catch {}
}

// ---------------- search ----------------
function renderSearchView() {
  $('#view-search').hidden = false;
  const q = $('#q');
  q.oninput = debounce(async () => {
    if (!q.value.trim()) { $('#search-results').innerHTML = ''; return; }
    const data = await api('/api/search?q=' + encodeURIComponent(q.value));
    const root = $('#search-results');
    root.innerHTML = '';
    if (data.tracks.length) {
      root.append(el('div', { class: 'section-title' }, 'Треки'));
      root.append(renderTracksGrid(data.tracks));
    }
    if (data.albums.length) {
      root.append(el('div', { class: 'section-title' }, 'Альбомы'));
      root.append(renderAlbumsGrid(data.albums));
    }
    if (data.artists.length) {
      root.append(el('div', { class: 'section-title' }, 'Артисты'));
      root.append(renderArtistsGrid(data.artists));
    }
    if (!data.tracks.length && !data.albums.length && !data.artists.length) {
      root.append(el('div', { class: 'section-title' }, 'Ничего не найдено'));
    }
  }, 350);
  q.focus();
}

function renderTracksGrid(tracks) {
  const grid = el('div', { class: 'track-grid' });
  tracks.forEach((t, i) => {
    const card = el('div', { class: 'track-card', onclick: () => (location.hash = `#/track/${t.id}`) },
      el('img', { src: t.album?.cover || '', alt: '' }),
      el('div', {},
        el('div', { class: 't-title' }, t.title),
        el('div', { class: 't-artist' }, [t.artist?.name, ...(t.contributors || []).slice(1).map(c => c.name)].filter(Boolean).join(', ')),
      ),
      el('button', {
        class: 't-play',
        onclick: (e) => { e.stopPropagation(); playQueue(tracks, i); },
      }, el('svg', { viewBox: '0 0 24 24', html: '<use href="#ic-play"/>' })),
    );
    grid.append(card);
  });
  return grid;
}
function renderAlbumsGrid(albums) {
  const grid = el('div', { class: 'album-grid' });
  albums.forEach(a => grid.append(el('div', {
    class: 'album-card',
    onclick: () => (location.hash = `#/album/${a.id}`),
  },
    el('img', { src: a.cover, alt: '' }),
    el('div', { class: 'a-title' }, a.title),
    el('div', { class: 'a-artist' }, a.artist?.name || ''),
  )));
  return grid;
}
function renderArtistsGrid(artists) {
  const grid = el('div', { class: 'artist-grid' });
  artists.forEach(a => grid.append(el('div', {
    class: 'artist-card',
    onclick: () => (location.hash = `#/artist/${a.id}`),
  },
    el('img', { src: a.picture, alt: '' }),
    el('div', { class: 'a-name' }, a.name),
  )));
  return grid;
}

// ---------------- track page ----------------
async function renderTrack(id) {
  const view = $('#view-track');
  view.hidden = false;
  view.innerHTML = '<div class="section-title">Загружаем…</div>';
  const { track, rating, reviews } = await api('/api/track/' + id);
  const artists = [track.artist, ...(track.contributors || []).filter(c => c.id !== track.artist?.id)];
  view.innerHTML = '';
  view.append(
    el('div', { class: 'entity-head glass' },
      el('img', { class: 'cover', src: track.album?.cover, alt: '' }),
      el('div', {},
        el('div', { class: 'subtitle' }, 'Трек'),
        el('h1', {}, track.title),
        el('div', { class: 'subtitle' }, artists.map(a =>
          a && el('a', { href: '#/artist/' + a.id }, a.name)).filter(Boolean).reduce((acc, cur, i, arr) => acc.concat(i > 0 ? [', ', cur] : [cur]), [])),
        el('div', { class: 'meta' },
          el('span', {}, 'Длительность: ' + fmtTime(track.duration)),
          track.album ? el('a', { href: '#/album/' + track.album.id }, 'Альбом: ' + track.album.title) : null,
          rating.avg ? el('span', {}, `Средняя оценка: ${rating.avg}/90 · ${rating.count} рец.`) : el('span', {}, 'Ещё нет оценок'),
        ),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn-primary', onclick: () => playQueue([track], 0) },
            el('svg', { class: 'ic', viewBox: '0 0 24 24', html: '<use href="#ic-play"/>' }), 'Слушать'),
          el('button', { class: 'btn btn-ghost', onclick: () => openReviewModal('track', track.id) }, 'Оценить / Рецензия'),
          el('button', { class: 'btn btn-ghost', onclick: () => toggleFav('track', track.id) },
            el('svg', { class: 'ic', viewBox: '0 0 24 24', html: '<use href="#ic-heart"/>' }), 'В избранное'),
        ),
        rating.avg ? el('div', { class: 'big-score' }, String(rating.avg), el('span', {}, ' / 90')) : null,
      ),
    ),
    el('div', { class: 'section-title' }, `Рецензии (${reviews.length})`),
    renderReviewsList(reviews),
  );
}

// ---------------- album page ----------------
async function renderAlbum(id) {
  const view = $('#view-album');
  view.hidden = false;
  view.innerHTML = '<div class="section-title">Загружаем…</div>';
  const { album, rating, reviews } = await api('/api/album/' + id);
  view.innerHTML = '';
  view.append(
    el('div', { class: 'entity-head glass' },
      el('img', { class: 'cover', src: album.cover, alt: '' }),
      el('div', {},
        el('div', { class: 'subtitle' }, 'Альбом · ' + (album.releaseDate || '')),
        el('h1', {}, album.title),
        el('div', { class: 'subtitle' }, album.artist ? el('a', { href: '#/artist/' + album.artist.id }, album.artist.name) : ''),
        el('div', { class: 'meta' },
          el('span', {}, album.nbTracks + ' треков'),
          el('span', {}, fmtTime(album.duration)),
          rating.avg ? el('span', {}, `${rating.avg}/90 · ${rating.count} рец.`) : el('span', {}, 'Оценок пока нет'),
        ),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn-primary', onclick: () => playQueue(album.tracks, 0) }, 'Слушать альбом'),
          el('button', { class: 'btn btn-ghost', onclick: () => openReviewModal('album', album.id) }, 'Оценить'),
          el('button', { class: 'btn btn-ghost', onclick: () => toggleFav('album', album.id) }, 'В избранное'),
        ),
      ),
    ),
    el('div', { class: 'section-title' }, 'Треки'),
    renderTracksGrid(album.tracks),
    el('div', { class: 'section-title' }, `Рецензии (${reviews.length})`),
    renderReviewsList(reviews),
  );
}

// ---------------- artist page ----------------
async function renderArtist(id) {
  const view = $('#view-artist');
  view.hidden = false;
  view.innerHTML = '<div class="section-title">Загружаем…</div>';
  const { artist, top, albums } = await api('/api/artist/' + id);
  view.innerHTML = '';
  view.append(
    el('div', { class: 'entity-head glass' },
      el('img', { class: 'cover', src: artist.picture, alt: '' }),
      el('div', {},
        el('div', { class: 'subtitle' }, 'Артист'),
        el('h1', {}, artist.name),
        el('div', { class: 'meta' },
          el('span', {}, artist.nbFan + ' поклонников'),
          el('span', {}, artist.nbAlbum + ' альбомов'),
        ),
      ),
    ),
    el('div', { class: 'section-title' }, 'Популярные треки'),
    renderTracksGrid(top),
    el('div', { class: 'section-title' }, 'Дискография'),
    renderAlbumsGrid(albums.map(a => ({ ...a, artist }))),
  );
}

// ---------------- reviews ----------------
function renderReviewsList(reviews) {
  const wrap = el('div', { class: 'rev-list' });
  if (!reviews.length) { wrap.append(el('div', { class: 'subtitle' }, 'Стань первым — оставь рецензию.')); return wrap; }
  reviews.forEach(r => {
    const author = r.author.username ? '@' + r.author.username : (r.author.firstName || 'Аноним');
    wrap.append(el('div', { class: 'rev-item' },
      el('div', { class: 'rev-total' }, `${r.total}/90`),
      el('div', { class: 'rev-author' },
        el('a', { href: '#/profile/' + r.author.tgId }, author),
        r.author.verified ? el('svg', { class: 'verified-badge', viewBox: '0 0 24 24', html: '<use href="#ic-verified"/>' }) : null,
        el('span', {}, '· ' + new Date(r.updatedAt).toLocaleDateString('ru-RU')),
      ),
      r.hasText ? el('h4', {}, r.title || 'Рецензия') : null,
      el('div', { class: 'rev-scores' },
        el('span', {}, 'Рифмы: ', el('b', {}, r.scores.rhymes)),
        el('span', {}, 'Ритмика: ', el('b', {}, r.scores.structure)),
        el('span', {}, 'Стиль: ', el('b', {}, r.scores.style)),
        el('span', {}, 'Индивидуальность: ', el('b', {}, r.scores.identity)),
        el('span', {}, 'Вайб: ', el('b', {}, r.scores.vibe)),
      ),
      r.hasText ? el('div', { class: 'rev-body' }, r.body) : null,
    ));
  });
  return wrap;
}

// ---------------- review modal ----------------
let reviewCtx = { targetType: '', targetId: null, mode: 'review' };

function openReviewModal(targetType, targetId) {
  if (!state.me) return toast('Войди через Telegram, чтобы оставить оценку');
  reviewCtx = { targetType, targetId, mode: 'review' };
  const modal = $('#modal-review');
  modal.hidden = false;
  modal.querySelectorAll('.rv-crit input').forEach(inp => { inp.value = 0; inp.parentElement.querySelector('.rv-val').textContent = 0; });
  $('#rv-title').value = '';
  $('#rv-body').value = '';
  updateReviewTotal();
  setReviewMode('review');
}

function setReviewMode(mode) {
  reviewCtx.mode = mode;
  $$('.rv-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $$('[data-visible-when]').forEach(n => (n.style.display = n.dataset.visibleWhen === mode ? '' : 'none'));
}

$$('.rv-tab').forEach(t => t.addEventListener('click', () => setReviewMode(t.dataset.mode)));

function updateReviewTotal() {
  let total = 0;
  $$('#modal-review .rv-crit').forEach(c => {
    const v = +c.querySelector('input').value;
    c.querySelector('.rv-val').textContent = v;
    total += v;
  });
  $('#rv-total').textContent = total;
}

$$('#modal-review .rv-crit input').forEach(inp => inp.addEventListener('input', updateReviewTotal));
$('#rv-body').addEventListener('input', (e) => { $('#rv-counter-cur').textContent = e.target.value.length; });

$('#rv-clear').addEventListener('click', () => {
  $$('#modal-review .rv-crit input').forEach(inp => (inp.value = 0));
  $('#rv-title').value = '';
  $('#rv-body').value = '';
  $('#rv-counter-cur').textContent = 0;
  updateReviewTotal();
});
$('#rv-info').addEventListener('click', () => ($('#modal-criteria').hidden = false));

$('#rv-submit').addEventListener('click', async () => {
  const scores = {};
  $$('#modal-review .rv-crit').forEach(c => (scores[c.dataset.key] = +c.querySelector('input').value));
  try {
    await api('/api/review', {
      method: 'POST',
      body: JSON.stringify({
        targetType: reviewCtx.targetType,
        targetId: reviewCtx.targetId,
        scores,
        title: $('#rv-title').value.trim(),
        body: $('#rv-body').value,
        mode: reviewCtx.mode,
      }),
    });
    $('#modal-review').hidden = true;
    toast('Оценка сохранена');
    route();
  } catch (e) {
    toast(e.data?.error || 'Ошибка сохранения');
  }
});

// ---------------- favorites ----------------
async function toggleFav(targetType, targetId) {
  if (!state.me) return toast('Войди, чтобы сохранять избранное');
  try {
    await api('/api/favorite', { method: 'POST', body: JSON.stringify({ targetType, targetId }) });
    toast('Добавлено в избранное');
  } catch { toast('Ошибка'); }
}

async function renderFavorites() {
  const view = $('#view-profile');
  view.hidden = false;
  view.innerHTML = '<h2 class="page-title">Избранное</h2>';
  const { tracks, albums } = await api('/api/favorites');
  if (!tracks.length && !albums.length) view.append(el('div', {}, 'Пока пусто.'));
  if (tracks.length) { view.append(el('div', { class: 'section-title' }, 'Треки')); view.append(renderTracksGrid(tracks)); }
  if (albums.length) { view.append(el('div', { class: 'section-title' }, 'Альбомы')); view.append(renderAlbumsGrid(albums)); }
}

// ---------------- profile ----------------
async function renderProfile(tgId) {
  if (!tgId) tgId = state.me?.tgId;
  if (!tgId) return toast('Войди через Telegram');
  const view = $('#view-profile');
  view.hidden = false;
  view.innerHTML = '<div class="section-title">Загружаем…</div>';
  const { user, reviews } = await api('/api/profile/' + tgId);
  const isMe = state.me && state.me.tgId === user.tgId;
  view.innerHTML = '';
  view.append(
    el('div', { class: 'profile-head glass' },
      el('img', { src: user.photoUrl || '', alt: '' }),
      el('div', {},
        el('h1', {}, user.firstName || (user.username ? '@' + user.username : 'Профиль'),
          user.verified ? el('svg', { class: 'verified-badge', viewBox: '0 0 24 24', html: '<use href="#ic-verified"/>' }) : null),
        el('div', { class: 'p-handle' }, user.username ? '@' + user.username : 'ID ' + user.tgId),
        user.bio ? el('div', { class: 'p-bio' }, user.bio) : null,
        isMe ? el('div', { class: 'actions', style: 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;' },
          el('button', { class: 'btn btn-ghost', onclick: () => editBio(user.bio) }, 'Редактировать био'),
          !user.verified ? el('button', { class: 'btn btn-primary', onclick: openVerifyModal }, 'Запросить верификацию') : null,
        ) : null,
      ),
    ),
    el('div', { class: 'section-title' }, `Рецензии (${reviews.length})`),
    renderProfileReviews(reviews),
  );
}
function renderProfileReviews(reviews) {
  const wrap = el('div', { class: 'rev-list' });
  reviews.forEach(r => {
    wrap.append(el('div', { class: 'rev-item' },
      el('div', { class: 'rev-total' }, `${r.total}/90`),
      el('div', { class: 'rev-author' },
        el('a', { href: `#/${r.target_type}/${r.target_id}` }, `${r.target_type === 'track' ? 'Трек' : 'Альбом'} #${r.target_id}`),
        el('span', {}, ' · ' + new Date(r.updated_at).toLocaleDateString('ru-RU')),
      ),
      r.has_text ? el('h4', {}, r.title) : null,
      r.has_text ? el('div', { class: 'rev-body' }, r.body) : null,
    ));
  });
  return wrap;
}
function editBio(current) {
  const b = prompt('Био (до 500 символов):', current || '');
  if (b == null) return;
  api('/api/profile/bio', { method: 'POST', body: JSON.stringify({ bio: b }) }).then(() => { toast('Сохранено'); route(); });
}

// ---------------- verify ----------------
function openVerifyModal() {
  if (!state.me) return toast('Войди');
  const wrap = el('div', { class: 'modal' },
    el('div', { class: 'modal-card glass', style: 'max-width:560px;text-align:left;' },
      el('h3', {}, 'Запрос верификации'),
      el('p', { style: 'color:var(--fg-dim);font-size:14px;' },
        'Критерии:',
        el('br'),
        '• ≥ 1000 подписчиков хотя бы в одной соцсети', el('br'),
        '• публично доступный музыкальный контент', el('br'),
        '• видео-подтверждение: ты сам произносишь фразу «Dreinnify, {ник}, {код}»', el('br'),
        '• отсутствие деструктивного/запрещённого контента'),
      el('input', { id: 'v-social', class: 'rv-input', placeholder: 'Ссылки на соцсети через запятую', style: 'margin-bottom:8px;' }),
      el('input', { id: 'v-video', class: 'rv-input', placeholder: 'Ссылка на видео-подтверждение (YouTube/VK/TG)', style: 'margin-bottom:8px;' }),
      el('textarea', { id: 'v-comment', class: 'rv-textarea', placeholder: 'Комментарий (необязательно)', style: 'min-height:80px;margin-bottom:12px;' }),
      el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' },
        el('button', { class: 'btn btn-ghost', 'data-close': true }, 'Отмена'),
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const socials = $('#v-social').value.split(',').map(s => s.trim()).filter(Boolean);
          const videoUrl = $('#v-video').value.trim();
          const comment = $('#v-comment').value.trim();
          if (!socials.length || !videoUrl) return toast('Заполни соцсети и видео');
          try {
            const r = await api('/api/verify/request', { method: 'POST', body: JSON.stringify({ socials, videoUrl, comment }) });
            toast('Заявка отправлена. Код: ' + r.code);
            wrap.remove();
          } catch (e) { toast(e.data?.error || 'Ошибка'); }
        }}, 'Отправить'),
      ),
      el('button', { class: 'modal-close', 'data-close': true }, '×'),
    ),
  );
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => wrap.remove()));
  document.body.append(wrap);
}

// ---------------- nominations (public) ----------------
async function renderNominations() {
  $('#view-nominations').hidden = false;
  const list = $('#noms-list');
  list.innerHTML = '';
  const { nominations } = await api('/api/nominations');
  if (!nominations.length) list.append(el('div', {}, 'Номинаций пока нет.'));
  nominations.forEach(n => {
    const card = el('div', { class: 'nom-card', style: `--nom-color:${n.color}55` },
      n.image_url ? el('img', { src: n.image_url }) : null,
      el('h3', {}, n.title),
      n.description ? el('p', {}, n.description) : null,
    );
    list.append(card);
  });
}

// ---------------- admin panel ----------------
async function renderAdmin() {
  if (!state.isAdmin) return toast('Только для админа');
  const view = $('#view-admin');
  view.hidden = false;
  view.innerHTML = '';
  const side = el('nav', { class: 'admin-side glass' });
  const main = el('div', { class: 'admin-main' });
  view.append(el('div', { class: 'admin-grid' }, side, main));

  const sections = [
    ['dashboard', 'Дашборд', adminDashboard],
    ['users', 'Пользователи', adminUsers],
    ['verify', 'Заявки на верификацию', adminVerify],
    ['nominations', 'Номинации', adminNominations],
    ['generator', 'Генератор картинок', adminGenerator],
  ];
  let current = 'dashboard';
  sections.forEach(([key, title, fn]) => {
    const b = el('button', { onclick: () => { current = key; refresh(); } }, title);
    if (key === current) b.classList.add('active');
    side.append(b);
  });
  function refresh() {
    side.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', sections[i][0] === current));
    main.innerHTML = '';
    sections.find(s => s[0] === current)[2](main);
  }
  refresh();
}

async function adminDashboard(root) {
  const s = await api('/api/admin/stats');
  root.append(el('h2', { class: 'page-title' }, 'Обзор'));
  const stats = el('div', { class: 'stat-grid' });
  [['Пользователей', s.users], ['Рецензий', s.reviews], ['Верифицированных', s.verified],
   ['Заявок в ожидании', s.pendingVerify], ['Номинаций', s.nominations]].forEach(([k, v]) =>
    stats.append(el('div', { class: 'stat-card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, String(v)))));
  root.append(stats);
}

async function adminUsers(root) {
  root.append(el('h2', { class: 'page-title' }, 'Пользователи'));
  const { users } = await api('/api/admin/users');
  const tbl = el('table', { class: 'table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'ID'), el('th', {}, 'TG'), el('th', {}, 'Username'),
      el('th', {}, 'Имя'), el('th', {}, 'Верификация'), el('th', {}, 'Действия'),
    )),
  );
  const tb = el('tbody');
  users.forEach(u => {
    const row = el('tr', {},
      el('td', {}, String(u.id)),
      el('td', {}, u.tg_id),
      el('td', {}, u.username || '—'),
      el('td', {}, u.first_name || '—'),
      el('td', {}, u.verified ? '✓' : '—'),
      el('td', {},
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          const note = prompt(u.verified ? 'Причина снятия верификации:' : 'Комментарий к верификации:', '');
          if (note == null) return;
          await api('/api/admin/verify-toggle', { method: 'POST', body: JSON.stringify({ userId: u.id, verified: !u.verified, note }) });
          adminUsers(root.innerHTML = '', root);
          root.innerHTML = '';
          adminUsers(root);
        }}, u.verified ? 'Снять' : 'Выдать верификацию'),
      ),
    );
    tb.append(row);
  });
  tbl.append(tb);
  root.append(tbl);
}

async function adminVerify(root) {
  root.append(el('h2', { class: 'page-title' }, 'Заявки на верификацию'));
  const { requests } = await api('/api/admin/verify-requests');
  if (!requests.length) { root.append(el('div', {}, 'Ничего в очереди.')); return; }
  requests.forEach(r => {
    const socials = JSON.parse(r.socials_json || '[]');
    root.append(el('div', { class: 'rev-item' },
      el('div', { class: 'rev-author' }, (r.username ? '@' + r.username : r.first_name) + ' · TG ' + r.tg_id),
      el('div', {}, 'Соцсети: ', socials.map(s => el('a', { href: s, target: '_blank', style: 'color:var(--accent);margin-right:8px' }, s))),
      el('div', {}, 'Видео: ', el('a', { href: r.video_url, target: '_blank', style: 'color:var(--accent)' }, r.video_url)),
      r.comment ? el('div', { class: 'rev-body', style: 'margin-top:8px;' }, r.comment) : null,
      el('div', { style: 'margin-top:12px;display:flex;gap:8px;' },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          await api('/api/admin/verify-decide', { method: 'POST', body: JSON.stringify({ id: r.id, decision: 'approve', note: '' }) });
          toast('Одобрено'); root.innerHTML = ''; adminVerify(root);
        }}, 'Одобрить'),
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          const note = prompt('Причина отказа:', '');
          await api('/api/admin/verify-decide', { method: 'POST', body: JSON.stringify({ id: r.id, decision: 'reject', note: note || '' }) });
          toast('Отклонено'); root.innerHTML = ''; adminVerify(root);
        }}, 'Отклонить'),
      ),
    ));
  });
}

async function adminNominations(root) {
  root.append(el('h2', { class: 'page-title' }, 'Номинации'));
  root.append(el('button', { class: 'btn btn-primary', onclick: () => editNom() }, '+ Создать номинацию'));
  const { nominations } = await api('/api/nominations');
  const grid = el('div', { class: 'noms-grid', style: 'margin-top:16px;' });
  nominations.forEach(n => {
    grid.append(el('div', { class: 'nom-card', style: `--nom-color:${n.color}55` },
      n.image_url ? el('img', { src: n.image_url }) : null,
      el('h3', {}, n.title),
      n.description ? el('p', {}, n.description) : null,
      el('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
        el('button', { class: 'btn btn-ghost', onclick: () => editNom(n) }, 'Редактировать'),
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          if (!confirm('Удалить номинацию?')) return;
          await api('/api/admin/nomination/' + n.id, { method: 'DELETE' });
          root.innerHTML = ''; adminNominations(root);
        }}, 'Удалить'),
      ),
    ));
  });
  root.append(grid);

  function editNom(existing) {
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card glass', style: 'max-width:520px;text-align:left;' },
        el('h3', {}, existing ? 'Редактировать номинацию' : 'Новая номинация'),
        el('input', { id: 'n-title', class: 'rv-input', placeholder: 'Название', value: existing?.title || '' }),
        el('textarea', { id: 'n-desc', class: 'rv-textarea', placeholder: 'Описание', style: 'min-height:80px;margin-top:8px;' }, existing?.description || ''),
        el('input', { id: 'n-image', class: 'rv-input', placeholder: 'URL картинки (например /generated/…)', value: existing?.image_url || '', style: 'margin-top:8px;' }),
        el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:8px;' },
          el('span', {}, 'Цвет: '),
          el('input', { id: 'n-color', class: 'color-input', type: 'color', value: existing?.color || '#7ea4ff' }),
        ),
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;' },
          el('button', { class: 'btn btn-ghost', onclick: () => wrap.remove() }, 'Отмена'),
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const body = JSON.stringify({
              title: $('#n-title').value.trim(),
              description: $('#n-desc').value.trim(),
              imageUrl: $('#n-image').value.trim(),
              color: $('#n-color').value,
            });
            if (existing) await api('/api/admin/nomination/' + existing.id, { method: 'PATCH', body });
            else await api('/api/admin/nomination', { method: 'POST', body });
            wrap.remove(); root.innerHTML = ''; adminNominations(root);
          }}, 'Сохранить'),
        ),
      ),
    );
    document.body.append(wrap);
  }
}

async function adminGenerator(root) {
  root.append(el('h2', { class: 'page-title' }, 'Генератор картинок номинаций'));
  const preview = el('div', { class: 'nom-card glass', style: 'max-width:520px;padding:16px;text-align:center;' },
    el('div', {}, 'Здесь появится картинка после генерации'),
  );
  const form = el('div', { class: 'glass', style: 'padding:20px;max-width:520px;display:grid;gap:10px;' },
    el('label', {}, 'Заголовок', el('input', { id: 'g-title', class: 'rv-input', placeholder: 'Лучший трек года', value: 'Лучший трек года' })),
    el('label', {}, 'Подзаголовок', el('input', { id: 'g-sub', class: 'rv-input', placeholder: 'Dreinnify Awards 2026' })),
    el('label', { style: 'display:flex;align-items:center;gap:8px;' }, 'Цвет 1',
      el('input', { id: 'g-c1', type: 'color', class: 'color-input', value: '#7ea4ff' }),
      'Цвет 2',
      el('input', { id: 'g-c2', type: 'color', class: 'color-input', value: '#c47bff' }),
    ),
    el('button', { class: 'btn btn-primary', onclick: async () => {
      const r = await api('/api/admin/nomination/generate', { method: 'POST', body: JSON.stringify({
        title: $('#g-title').value, subtitle: $('#g-sub').value,
        color: $('#g-c1').value, accent: $('#g-c2').value,
      })});
      preview.innerHTML = '';
      preview.append(el('img', { src: r.url, style: 'width:100%;border-radius:12px;' }));
      preview.append(el('div', { style: 'margin-top:8px;color:var(--fg-dim);font-size:13px;' }, 'URL: ' + r.url));
    }}, 'Сгенерировать'),
  );
  root.append(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;' }, form, preview));
}

// ---------------- player (background playback) ----------------
const audio = $('#pl-audio');
const player = $('#player');

async function playQueue(tracks, index = 0) {
  if (!tracks.length) return;
  state.queue = tracks;
  state.qIndex = index;
  await playCurrent();
}

async function playCurrent() {
  const t = state.queue[state.qIndex];
  if (!t) return;
  state.currentTrackId = t.id;
  player.hidden = false;
  $('#pl-cover').src = t.album?.cover || '';
  $('#pl-title').textContent = t.title;
  $('#pl-artist').textContent = [t.artist?.name, ...(t.contributors || []).slice(1).map(c => c.name)].filter(Boolean).join(', ');
  try {
    const info = await api('/api/stream/' + t.id);
    audio.src = info.url;
    await audio.play();
    state.playing = true;
    updatePlayIcon();
    setupMediaSession(t);
  } catch (e) {
    toast('Не удалось воспроизвести');
    console.error(e);
  }
  loadLyrics(t.id);
}

function setupMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: [t.artist?.name, ...(t.contributors || []).slice(1).map(c => c.name)].filter(Boolean).join(', '),
    album: t.album?.title || '',
    artwork: t.album?.cover ? [{ src: t.album.cover, sizes: '250x250', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
  navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
}

function updatePlayIcon() {
  $('#pl-play').innerHTML = `<svg viewBox="0 0 24 24"><use href="#ic-${state.playing ? 'pause' : 'play'}"/></svg>`;
}

$('#pl-play').addEventListener('click', () => {
  if (audio.paused) audio.play(); else audio.pause();
});
audio.addEventListener('play', () => { state.playing = true; updatePlayIcon(); });
audio.addEventListener('pause', () => { state.playing = false; updatePlayIcon(); });
audio.addEventListener('ended', () => playNext());
audio.addEventListener('timeupdate', () => {
  $('#pl-cur').textContent = fmtTime(audio.currentTime);
  $('#pl-dur').textContent = fmtTime(audio.duration);
  if (audio.duration) $('#pl-seek').value = (audio.currentTime / audio.duration) * 1000;
  syncKaraoke(audio.currentTime);
});
$('#pl-seek').addEventListener('input', (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration;
});
$('#pl-vol').addEventListener('input', (e) => (audio.volume = e.target.value / 100));
audio.volume = 0.8;

$('#pl-prev').addEventListener('click', playPrev);
$('#pl-next').addEventListener('click', playNext);
function playPrev() { if (state.qIndex > 0) { state.qIndex--; playCurrent(); } }
function playNext() { if (state.qIndex < state.queue.length - 1) { state.qIndex++; playCurrent(); } }

// ---------------- lyrics / karaoke ----------------
$('#pl-lyrics').addEventListener('click', () => ($('#karaoke').hidden = !$('#karaoke').hidden));
$('#ka-close').addEventListener('click', () => ($('#karaoke').hidden = true));

async function loadLyrics(trackId) {
  state.lyrics = null;
  const body = $('#ka-body');
  body.innerHTML = 'Загружаем текст…';
  try {
    const data = await api('/api/track/' + trackId + '/lyrics');
    if (data.synced && data.synced.length) {
      state.lyrics = data.synced;
      body.innerHTML = '';
      data.synced.forEach((ln, i) => body.append(el('div', { class: 'ka-line', 'data-i': i }, ln.text || ' ')));
    } else if (data.plain) {
      state.lyrics = null;
      body.innerHTML = '';
      body.append(el('div', { style: 'white-space:pre-wrap;color:var(--fg-dim);' }, data.plain));
    } else {
      body.innerHTML = '<div style="color:var(--fg-mute)">Текст не найден.</div>';
    }
  } catch { body.innerHTML = 'Ошибка загрузки текста'; }
}

function syncKaraoke(t) {
  if (!state.lyrics || $('#karaoke').hidden) return;
  const lines = state.lyrics;
  let cur = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].t <= t) cur = i; else break; }
  const body = $('#ka-body');
  const nodes = body.querySelectorAll('.ka-line');
  if (!nodes.length) return;
  nodes.forEach((n, i) => n.classList.toggle('active', i === cur));
  if (cur >= 0) {
    const active = nodes[cur];
    const boxTop = body.getBoundingClientRect().top;
    const linTop = active.getBoundingClientRect().top;
    body.scrollTop += (linTop - boxTop) - body.clientHeight / 2 + active.clientHeight / 2;
  }
}

// ---------------- boot ----------------
(async function boot() {
  try { await loadMe(); } catch {}
  route();
})();

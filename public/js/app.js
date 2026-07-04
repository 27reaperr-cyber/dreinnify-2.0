/* ============ DREINNIFY — CLIENT ============ */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const escapeHtml = (s) => (s || '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDur = (sec) => { sec = Math.floor(sec || 0); const m = Math.floor(sec/60); const s = sec%60; return `${m}:${s.toString().padStart(2,'0')}`; };
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });

const state = {
  user: null,
  config: {},
  playerQueue: [],
  playerIndex: 0,
  currentLyrics: null,
  lyricsTimer: null,
};

const VERIFIED_SVG = `
<svg viewBox="0 0 22 22" width="16" height="16">
  <defs><linearGradient id="vg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6cff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs>
  <path d="M11 1.5 13 3.5l2.8-.5.7 2.7 2.5 1.4-.9 2.7 1.4 2.5-2 2 .1 2.9-2.7.9-1.4 2.5-2.7-.7L11 20.5l-2.1-1.7-2.7.7L4.8 17l-2.7-.9.1-2.9-2-2 1.4-2.5-.9-2.7L3.2 4.6l.7-2.7L6.7 3z" fill="url(#vg)"/>
  <path d="M7 11l3 3 5-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.borderColor = err ? 'rgba(239,68,68,0.5)' : '';
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'include', headers: opts.body && !(opts.body instanceof FormData) ? {'Content-Type':'application/json'} : {}, ...opts });
  if (!res.ok) {
    let e = 'HTTP '+res.status;
    try { const j = await res.json(); e = j.error || e; } catch {}
    throw new Error(e);
  }
  return res.json();
}

// ============ АУТЕНТИФИКАЦИЯ ============
async function refreshMe() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
    renderUserSlot();
    updateNavAuth();
  } catch { state.user = null; renderUserSlot(); updateNavAuth(); }
}

function renderUserSlot() {
  const slot = $('#user-slot');
  if (!state.user) {
    slot.innerHTML = `<button class="btn btn-primary btn-sm" onclick="openLogin()">Войти</button>`;
    return;
  }
  const u = state.user;
  const avatar = u.photo_url ? `<img src="${u.photo_url}" alt="">` : `<span>${(u.first_name || u.username || '?')[0].toUpperCase()}</span>`;
  slot.innerHTML = `<button class="user-avatar-btn" onclick="navigate('/me')" title="Профиль">${avatar}</button>`;
}

function updateNavAuth() {
  $$('#nav-links [data-auth]').forEach(el => el.style.display = state.user ? '' : 'none');
  $$('#nav-links [data-admin]').forEach(el => el.style.display = (state.user && state.user.is_admin) ? '' : 'none');
}

async function openLogin() {
  const { token, link } = await api('/api/auth/request', { method: 'POST' });
  showModal(`
    <h3>Вход через Telegram</h3>
    <p>Нажмите кнопку — откроется бот, где нужно нажать «Start». После этого вернитесь сюда — вход произойдёт автоматически.</p>
    <a href="${link}" target="_blank" class="btn btn-primary btn-block" style="justify-content:center; margin-top:8px;">Открыть Telegram-бот</a>
    <div class="dim mt-16 center" style="font-size:12px">Ждём подтверждения…</div>
  `);
  const timer = setInterval(async () => {
    try {
      const r = await api(`/api/auth/check?token=${token}`);
      if (r.ok) {
        clearInterval(timer);
        closeModal();
        toast('Добро пожаловать в Dreinnify!');
        await refreshMe();
        navigate(location.pathname);
      }
    } catch {}
  }, 1500);
  const cleanup = () => { clearInterval(timer); document.removeEventListener('modal-closed', cleanup); };
  document.addEventListener('modal-closed', cleanup);
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  toast('Вы вышли из аккаунта');
  renderUserSlot(); updateNavAuth();
  navigate('/');
}

// ============ МОДАЛКА ============
function showModal(html) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal';
  overlay.innerHTML = `<div class="modal glass">${html}</div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
}
function closeModal() {
  const m = $('#modal');
  if (m) { m.remove(); document.dispatchEvent(new CustomEvent('modal-closed')); }
}

// ============ РОУТИНГ ============
function navigate(to, replace = false) {
  if (replace) history.replaceState({}, '', to); else history.pushState({}, '', to);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', render);

function render() {
  const p = location.pathname;
  updateActiveNav(p);
  if (p === '/') return renderHome();
  if (p === '/top') return renderTop();
  if (p === '/me') return renderMyProfile();
  if (p === '/verify') return renderVerify();
  if (p === '/admin') return renderAdmin();
  const m1 = p.match(/^\/track\/(.+)/); if (m1) return renderItem('track', m1[1]);
  const m2 = p.match(/^\/album\/(.+)/); if (m2) return renderItem('album', m2[1]);
  const m3 = p.match(/^\/artist\/(.+)/); if (m3) return renderArtist(m3[1]);
  const m4 = p.match(/^\/profile\/(.+)/); if (m4) return renderProfile(m4[1]);
  return renderHome();
}

function updateActiveNav(path) {
  $$('#nav-links a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

// ============ ГЛАВНАЯ ============
async function renderHome() {
  const app = $('#app');
  app.innerHTML = `
    <section class="hero glass">
      <h1><span class="accent">Dreinnify</span> — русская музыка<br>сквозь призму 90 баллов.</h1>
      <p>Слушайте, оценивайте и делитесь рецензиями. Пять критериев, ноль воды. Присоединяйтесь к сообществу.</p>
      <div class="hero-actions">
        <button class="btn btn-primary" onclick="openSearch()">Найти музыку</button>
        <a href="/top" data-nav class="btn btn-ghost">Топ месяца</a>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>Топ трека дня</h2><a href="/top" data-nav class="link">Смотреть все →</a></div>
      <div id="top-tracks" class="grid grid-tracks"></div>
    </section>

    <section class="section">
      <div class="section-title"><h2>Лучшие альбомы месяца</h2><a href="/top" data-nav class="link">Смотреть все →</a></div>
      <div id="top-albums" class="grid grid-tracks"></div>
    </section>
  `;
  try {
    const [tt, ta] = await Promise.all([
      api('/api/top?type=track&period=week'),
      api('/api/top?type=album&period=month'),
    ]);
    $('#top-tracks').innerHTML = tt.items.slice(0,10).map(it => renderCard(it, 'track')).join('') || placeholderTracks(10, 'track');
    $('#top-albums').innerHTML = ta.items.slice(0,8).map(it => renderCard(it, 'album')).join('') || placeholderTracks(8, 'album');
  } catch (e) {
    console.error(e);
  }
  // Если ничего нет — покажем популярные из Deezer
  if (!$('#top-tracks').children.length || $('#top-tracks').innerHTML.includes('placeholder')) {
    try {
      const r = await api('/api/search?q=' + encodeURIComponent('русский рэп'));
      $('#top-tracks').innerHTML = r.tracks.slice(0,10).map(t => renderTrackCard(t)).join('');
      const r2 = await api('/api/search?q=' + encodeURIComponent('хиты'));
      $('#top-albums').innerHTML = r2.albums.slice(0,8).map(a => renderAlbumCard(a)).join('');
    } catch {}
  }
}

function placeholderTracks(n, type) {
  return Array.from({length:n}).map(() => `<div class="card glass"><div class="card-cover" style="background:linear-gradient(135deg,#1a1a24,#0e0e14)"></div><div class="card-title">—</div><div class="card-artist">Пока пусто</div></div>`).join('');
}

function renderCard(it, type) {
  const cover = it.item_cover || '';
  const score = it.avg_total ? `<div class="card-score">${Math.round(it.avg_total)}/90</div>` : '';
  return `
    <div class="card glass" onclick="navigate('/${type}/${it.item_id}')">
      <div class="card-cover">
        ${cover ? `<img src="${cover}" alt="">` : ''}
        ${score}
        <div class="card-play" onclick="event.stopPropagation(); ${type==='track'?`playTrackById('${it.item_id}')`:`openAlbumAndPlay('${it.item_id}')`}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="#0a0a0f"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="card-title">${escapeHtml(it.item_title || '—')}</div>
      <div class="card-artist">${escapeHtml(it.item_artist || '')}</div>
    </div>`;
}
function renderTrackCard(t) {
  return `
    <div class="card glass" onclick="navigate('/track/${t.id}')">
      <div class="card-cover">
        ${t.cover ? `<img src="${t.cover}" alt="">` : ''}
        <div class="card-play" onclick="event.stopPropagation(); playTrack(${JSON.stringify(t).replace(/"/g,'&quot;')})">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="#0a0a0f"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
      <div class="card-title">${escapeHtml(t.title)}</div>
      <div class="card-artist">${escapeHtml((t.artists && t.artists.length ? t.artists.join(', ') : t.artist))}</div>
    </div>`;
}
function renderAlbumCard(a) {
  return `
    <div class="card glass" onclick="navigate('/album/${a.id}')">
      <div class="card-cover">
        ${a.cover ? `<img src="${a.cover}" alt="">` : ''}
      </div>
      <div class="card-title">${escapeHtml(a.title)}</div>
      <div class="card-artist">${escapeHtml(a.artist)}</div>
    </div>`;
}

// ============ ПОИСК ============
function openSearch() { $('#search-overlay').classList.remove('hidden'); setTimeout(() => $('#search-input').focus(), 60); }
function closeSearch() { $('#search-overlay').classList.add('hidden'); $('#search-input').value = ''; $('#search-results').innerHTML = ''; }
$('#btn-search').addEventListener('click', openSearch);
$('#search-close').addEventListener('click', closeSearch);
$('#search-overlay').addEventListener('click', (e) => { if (e.target.id === 'search-overlay') closeSearch(); });

let searchDebounce;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (!q) { $('#search-results').innerHTML = ''; return; }
  searchDebounce = setTimeout(async () => {
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      renderSearchResults(r);
    } catch (e) { $('#search-results').innerHTML = `<div class="dim center" style="padding:24px">Ошибка поиска</div>`; }
  }, 250);
});

function renderSearchResults(r) {
  const box = $('#search-results');
  let html = '';
  if (r.tracks.length) {
    html += `<div class="search-group">Треки</div>` + r.tracks.slice(0,10).map(t => `
      <div class="search-item" onclick="closeSearch(); navigate('/track/${t.id}')">
        <img src="${t.cover||''}" alt="">
        <div><div class="si-title">${escapeHtml(t.title)}</div><div class="si-artist">${escapeHtml((t.artists && t.artists.length? t.artists.join(', '): t.artist))}</div></div>
        <span class="si-kind">трек</span>
      </div>`).join('');
  }
  if (r.albums.length) {
    html += `<div class="search-group">Альбомы</div>` + r.albums.slice(0,6).map(a => `
      <div class="search-item" onclick="closeSearch(); navigate('/album/${a.id}')">
        <img src="${a.cover||''}" alt="">
        <div><div class="si-title">${escapeHtml(a.title)}</div><div class="si-artist">${escapeHtml(a.artist)}</div></div>
        <span class="si-kind">альбом</span>
      </div>`).join('');
  }
  if (r.artists.length) {
    html += `<div class="search-group">Артисты</div>` + r.artists.slice(0,6).map(a => `
      <div class="search-item" onclick="closeSearch(); navigate('/artist/${a.id}')">
        <img src="${a.picture||''}" alt="" style="border-radius:50%">
        <div><div class="si-title">${escapeHtml(a.name)}</div><div class="si-artist">${a.nb_fan?a.nb_fan.toLocaleString('ru-RU')+' поклонников':''}</div></div>
        <span class="si-kind">артист</span>
      </div>`).join('');
  }
  box.innerHTML = html || `<div class="dim center" style="padding:24px">Ничего не найдено</div>`;
}

// ============ ДЕТАЛЬНАЯ (track/album) ============
async function renderItem(type, id) {
  const app = $('#app');
  app.innerHTML = `<div class="dim center" style="padding:60px">Загрузка…</div>`;
  try {
    const data = await api(`/api/${type}/${id}`);
    const reviewsData = await api(`/api/reviews?item_type=${type}&item_id=${id}`);
    let myReview = null;
    if (state.user) {
      try { myReview = (await api(`/api/review/mine?item_type=${type}&item_id=${id}`)).review; } catch {}
    }
    let isFav = false;
    if (state.user) {
      try { isFav = (await api(`/api/favorite/check?item_type=${type}&item_id=${id}`)).favorited; } catch {}
    }

    const cover = data.cover || '';
    const artistLine = type === 'track'
      ? (data.contributors && data.contributors.length
          ? data.contributors.map(c => `<a href="/artist/${c.id}" data-nav>${escapeHtml(c.name)}</a>`).join('<span class="sep">·</span>')
          : `<a href="/artist/${data.artist_id}" data-nav>${escapeHtml(data.artist)}</a>`)
      : `<a href="/artist/${data.artist_id}" data-nav>${escapeHtml(data.artist)}</a>`;

    const meta = type === 'track'
      ? `${data.album ? `<a href="/album/${data.album_id}" data-nav>${escapeHtml(data.album)}</a> · ` : ''}${fmtDur(data.duration)}${data.release_date ? ' · ' + data.release_date.slice(0,4) : ''}`
      : `${data.nb_tracks} треков · ${fmtDur(data.duration)}${data.release_date ? ' · ' + data.release_date.slice(0,4) : ''}${data.genres && data.genres.length ? ' · ' + data.genres.join(', ') : ''}`;

    const avg = reviewsData.average;

    app.innerHTML = `
      <div class="item-header glass">
        <div class="bg-blur" style="background-image:url('${cover}')"></div>
        <div class="item-cover"><img src="${cover}" alt=""></div>
        <div>
          <div class="item-kind">${type === 'track' ? 'Трек' : 'Альбом'}</div>
          <h1 class="item-title">${escapeHtml(data.title)}</h1>
          <div class="item-artist">${artistLine}</div>
          <div class="item-meta">${meta}</div>
          <div class="item-actions">
            ${type === 'track'
              ? `<button class="btn btn-primary" onclick='playTrackData(${JSON.stringify({id:data.id,title:data.title,artist:data.artist,artists:data.artists,cover:data.cover,preview:data.preview}).replace(/"/g,"&quot;")})'>▶ Слушать</button>`
              : `<button class="btn btn-primary" onclick='playAlbumTracks(${JSON.stringify(data.tracks.map(t => ({id:t.id,title:t.title,artist:t.artist,artists:t.artists,cover:data.cover,preview:t.preview}))).replace(/"/g,"&quot;")})'>▶ Слушать альбом</button>`
            }
            <button class="btn ${isFav?'btn-danger':'btn-ghost'}" id="fav-btn" onclick="toggleFav('${type}','${data.id}', ${JSON.stringify({t:data.title,a:type==='track'?data.artist:data.artist,c:data.cover}).replace(/"/g,'&quot;')})">${isFav?'♥ В избранном':'♡ В избранное'}</button>
            ${type==='track' ? `<button class="btn btn-ghost" onclick="openLyricsFor('${escapeHtml(data.title)} ${escapeHtml(data.artist)}', '${escapeHtml(data.title)}', '${escapeHtml(data.artist)}')">🎤 Караоке</button>`: ''}
            ${avg !== null ? `<div class="avg-badge"><span class="n">${Math.round(avg)}</span><span class="d">/90 · ${reviewsData.count} оценок</span></div>` : `<div class="chip">Ещё нет оценок</div>`}
          </div>
        </div>
      </div>

      ${type === 'album' ? `
        <section class="section">
          <div class="section-title"><h2>Треклист</h2></div>
          <div class="grid grid-list">
            ${data.tracks.map((t, i) => `
              <div class="track-row glass" onclick="navigate('/track/${t.id}')">
                <div class="tr-num">${i+1}</div>
                <div class="tr-cover"><img src="${data.cover}" alt=""></div>
                <div><div class="tr-title">${escapeHtml(t.title)}</div><div class="tr-artist">${escapeHtml((t.artists && t.artists.length? t.artists.join(', '): t.artist))}</div></div>
                <div class="tr-time">${fmtDur(t.duration)}</div>
                <div class="tr-actions">
                  <button class="icon-btn" onclick="event.stopPropagation(); playTrackData(${JSON.stringify({id:t.id,title:t.title,artist:t.artist,artists:t.artists,cover:data.cover,preview:t.preview}).replace(/"/g,'&quot;')})">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
              </div>`).join('')}
          </div>
        </section>
      ` : ''}

      ${state.user ? renderRateBlock(type, data, myReview) : `
        <section class="section">
          <div class="rate-block glass center">
            <p class="dim">Войдите, чтобы поставить оценку или написать рецензию</p>
            <button class="btn btn-primary mt-16" onclick="openLogin()">Войти через Telegram</button>
          </div>
        </section>`}

      <section class="section">
        <div class="section-title"><h2>Рецензии и оценки (${reviewsData.count})</h2></div>
        <div class="reviews-list">
          ${reviewsData.reviews.length ? reviewsData.reviews.map(renderReviewCard).join('') : '<div class="dim center" style="padding:40px">Пока никто не оставил оценок</div>'}
        </div>
      </section>
    `;

    setupRateBlock(type, data, myReview);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="dim center" style="padding:60px">Не удалось загрузить: ${e.message}</div>`;
  }
}

function renderRateBlock(type, data, my) {
  const v = my || { rhymes:5, structure:5, style:5, charisma:5, vibe:1, title:'', body:'' };
  return `
    <section class="section">
      <div class="rate-block glass">
        <div class="rate-tabs">
          <div class="rate-tab active" data-mode="review">Рецензия</div>
          <div class="rate-tab" data-mode="rate">Оценка без рецензии</div>
        </div>
        <div class="rate-sliders">
          <div class="rate-row-4" style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:10px">
            ${slider('rhymes','Рифмы / Образы', v.rhymes)}
            ${slider('structure','Структура / Ритмика', v.structure)}
            ${slider('style','Реализация стиля', v.style)}
            ${slider('charisma','Индивидуальность / Харизма', v.charisma)}
          </div>
          ${slider('vibe','Атмосфера / Вайб', v.vibe, true)}
        </div>
        <div class="rate-fields" id="rate-fields">
          <input type="text" id="rev-title" placeholder="Заголовок рецензии" value="${escapeHtml(v.title || '')}">
          <textarea id="rev-body" placeholder="Текст рецензии (от 300 до 8500 символов)">${escapeHtml(v.body || '')}</textarea>
        </div>
        <div class="rate-footer">
          <div class="row">
            <button class="criteria-btn" type="button" onclick="showCriteria()">ⓘ Критерии 90-балльной системы оценивания</button>
            <span class="char-count" id="rev-count">0/8500</span>
          </div>
          <div class="rate-total"><span class="n" id="rate-total">28</span><span class="d">/90</span></div>
        </div>
        <div class="rate-footer" style="margin-top:12px">
          <div class="actions">
            ${my ? `<button class="btn btn-danger btn-sm" onclick="deleteReview(${my.id})">Удалить</button>` : ''}
          </div>
          <div class="actions">
            <button class="btn btn-ghost btn-sm" onclick="clearRateForm()">Очистить черновик</button>
            <button class="btn btn-primary" onclick="submitReview('${type}', ${JSON.stringify({id:data.id,title:data.title,artist:data.artist||'',cover:data.cover||''}).replace(/"/g,'&quot;')})">Опубликовать ✓</button>
          </div>
        </div>
      </div>
    </section>`;
}

function slider(key, label, val, big) {
  return `
    <div class="rate-slider ${big?'vibe':''}" data-key="${key}">
      <div class="rs-head"><span>${label}</span><span class="rs-val">${val}</span></div>
      <input type="range" min="0" max="10" value="${val}" step="1">
    </div>`;
}

function setupRateBlock(type, data, my) {
  const block = $('.rate-block'); if (!block) return;
  $$('.rate-slider', block).forEach(s => {
    const inp = $('input', s), val = $('.rs-val', s);
    inp.addEventListener('input', () => { val.textContent = inp.value; updateRateTotal(); });
  });
  $$('.rate-tab', block).forEach(t => {
    t.addEventListener('click', () => {
      $$('.rate-tab', block).forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const isRate = t.dataset.mode === 'rate';
      $('#rate-fields').style.display = isRate ? 'none' : '';
    });
  });
  const body = $('#rev-body'), count = $('#rev-count');
  body.addEventListener('input', () => count.textContent = `${body.value.length}/8500`);
  count.textContent = `${body.value.length}/8500`;
  updateRateTotal();
}
function updateRateTotal() {
  const vals = ['rhymes','structure','style','charisma','vibe'].map(k => parseInt($(`.rate-slider[data-key=${k}] input`).value || 0));
  const sum = vals.reduce((a,b)=>a+b, 0);
  const total90 = Math.round(sum * 1.8);
  $('#rate-total').textContent = total90;
}

async function submitReview(type, meta) {
  const vals = {};
  ['rhymes','structure','style','charisma','vibe'].forEach(k => vals[k] = parseInt($(`.rate-slider[data-key=${k}] input`).value || 0));
  const mode = $('.rate-tab.active').dataset.mode;
  const title = mode === 'review' ? $('#rev-title').value.trim() : '';
  const body = mode === 'review' ? $('#rev-body').value.trim() : '';
  if (mode === 'review' && body.length < 300) return toast('Рецензия должна быть от 300 символов', true);
  try {
    await api('/api/review', {
      method: 'POST',
      body: JSON.stringify({
        item_type: type, item_id: meta.id,
        item_title: meta.title, item_artist: meta.artist, item_cover: meta.cover,
        ...vals, title, body,
      })
    });
    toast('Оценка опубликована ✓');
    setTimeout(() => renderItem(type, meta.id), 500);
  } catch (e) { toast(e.message, true); }
}

async function deleteReview(id) {
  if (!confirm('Удалить оценку?')) return;
  try {
    await api('/api/review/' + id, { method: 'DELETE' });
    toast('Удалено');
    render();
  } catch (e) { toast(e.message, true); }
}

function clearRateForm() {
  ['rhymes','structure','style','charisma','vibe'].forEach(k => {
    const inp = $(`.rate-slider[data-key=${k}] input`), val = $(`.rate-slider[data-key=${k}] .rs-val`);
    const def = k === 'vibe' ? 1 : 5;
    inp.value = def; val.textContent = def;
  });
  $('#rev-title').value = ''; $('#rev-body').value = ''; $('#rev-count').textContent = '0/8500';
  updateRateTotal();
}

function renderReviewCard(r) {
  const u = r.user;
  const avatar = u.photo_url ? `<img src="${u.photo_url}" alt="">` : `<div class="rv-initials">${(u.first_name||u.username||'?')[0].toUpperCase()}</div>`;
  const name = escapeHtml(u.first_name || u.username || 'Аноним');
  const scores = [
    ['Рифмы', r.rhymes], ['Структура', r.structure], ['Стиль', r.style], ['Харизма', r.charisma], ['Вайб', r.vibe],
  ];
  return `
    <div class="review-card glass">
      <div class="review-head">
        <a class="rv-avatar" href="/profile/${u.telegram_id}" data-nav>${avatar}</a>
        <div>
          <div class="rv-name"><a href="/profile/${u.telegram_id}" data-nav>${name}</a>${u.verified ? `<span class="verified-tick" title="Верифицирован">${VERIFIED_SVG}</span>` : ''}</div>
          <div class="rv-date">${fmtDate(r.created_at)}</div>
        </div>
        <div class="rv-total">${r.total}<span class="d">/90</span></div>
      </div>
      ${r.title ? `<div class="review-title">${escapeHtml(r.title)}</div>` : ''}
      ${r.body ? `<div class="review-body">${escapeHtml(r.body)}</div>` : ''}
      <div class="review-scores">
        ${scores.map(([l,v]) => `<span class="sc"><b>${v}</b>${l}</span>`).join('')}
      </div>
    </div>`;
}

function showCriteria() {
  api('/api/criteria').then(({ criteria, verify_criteria }) => {
    showModal(`
      <h3>Критерии 90-балльной системы</h3>
      <p>Каждый параметр от 0 до 10. Итог × 1.8 = /90.</p>
      <div class="stack">
        ${criteria.map(c => `<div class="glass" style="padding:14px 16px; border-radius:12px"><div style="font-weight:600; margin-bottom:4px">${c.title}</div><div class="dim" style="font-size:13px">${c.desc}</div></div>`).join('')}
      </div>
      <h3 style="margin-top:20px">Верификация</h3>
      <ul style="margin-left:16px; color:var(--text-dim); font-size:14px">
        ${verify_criteria.map(v => `<li style="margin-bottom:4px">${escapeHtml(v)}</li>`).join('')}
      </ul>
    `);
  });
}

// ============ ИЗБРАННОЕ ============
async function toggleFav(type, id, meta) {
  if (!state.user) return openLogin();
  try {
    const r = await api('/api/favorite', {
      method: 'POST',
      body: JSON.stringify({ item_type: type, item_id: id, item_title: meta.t, item_artist: meta.a, item_cover: meta.c })
    });
    toast(r.favorited ? 'Добавлено в избранное ♥' : 'Убрано из избранного');
    const btn = $('#fav-btn');
    if (btn) { btn.textContent = r.favorited ? '♥ В избранном' : '♡ В избранное'; btn.className = 'btn ' + (r.favorited?'btn-danger':'btn-ghost'); }
  } catch (e) { toast(e.message, true); }
}

// ============ ПЛЕЕР ============
const audio = $('#pl-audio');
const player = $('#player');

function playTrackData(t) {
  state.playerQueue = [t]; state.playerIndex = 0; playCurrent();
}
async function playTrackById(id) {
  try {
    const t = await api('/api/track/' + id);
    playTrackData(t);
  } catch (e) { toast(e.message, true); }
}
function playAlbumTracks(tracks) {
  if (!tracks || !tracks.length) return;
  state.playerQueue = tracks; state.playerIndex = 0; playCurrent();
}
async function openAlbumAndPlay(id) {
  try {
    const a = await api('/api/album/' + id);
    playAlbumTracks(a.tracks.map(t => ({ id:t.id, title:t.title, artist:t.artist, artists:t.artists, cover:a.cover, preview:t.preview })));
  } catch(e){ toast(e.message, true); }
}

function playCurrent() {
  const t = state.playerQueue[state.playerIndex];
  if (!t) return;
  player.classList.remove('hidden');
  $('#pl-cover').src = t.cover || '';
  $('#pl-title').textContent = t.title;
  $('#pl-artist').textContent = (t.artists && t.artists.length ? t.artists.join(', ') : t.artist) || '';
  // Приоритет: YouTube Music полный трек. Fallback: preview из Deezer (30 сек)
  const q = `${t.artist||''} ${t.title}`.trim();
  const streamUrl = `/api/stream?q=${encodeURIComponent(q)}`;
  audio.src = streamUrl;
  audio.play().catch(err => {
    console.warn('YT stream failed, fallback to preview', err);
    if (t.preview) { audio.src = t.preview; audio.play().catch(()=>{}); }
    else toast('Не удалось воспроизвести', true);
  });
  setPlayIcon(true);
}

function setPlayIcon(playing) {
  $('#pl-icon').innerHTML = playing
    ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

$('#pl-play').addEventListener('click', () => {
  if (audio.paused) audio.play(); else audio.pause();
});
audio.addEventListener('play', () => setPlayIcon(true));
audio.addEventListener('pause', () => setPlayIcon(false));
audio.addEventListener('timeupdate', () => {
  $('#pl-time-cur').textContent = fmtDur(audio.currentTime);
  $('#pl-time-tot').textContent = fmtDur(audio.duration);
  $('#pl-progress-bar').style.width = (audio.currentTime / (audio.duration||1) * 100) + '%';
  updateLyricsPosition();
});
audio.addEventListener('ended', () => {
  if (state.playerIndex < state.playerQueue.length - 1) { state.playerIndex++; playCurrent(); }
});
$('#pl-progress').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const p = (e.clientX - rect.left) / rect.width;
  audio.currentTime = p * (audio.duration || 0);
});
$('#pl-next').addEventListener('click', () => {
  if (state.playerIndex < state.playerQueue.length - 1) { state.playerIndex++; playCurrent(); }
});
$('#pl-prev').addEventListener('click', () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.playerIndex > 0) { state.playerIndex--; playCurrent(); }
});
$('#pl-close').addEventListener('click', () => {
  audio.pause(); audio.src = ''; player.classList.add('hidden');
});

// Медиа-сессия — фоновое проигрывание
audio.addEventListener('play', () => {
  const t = state.playerQueue[state.playerIndex];
  if (!t || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: (t.artists?t.artists.join(', '):t.artist)||'', album: '', artwork: t.cover?[{src:t.cover, sizes:'500x500'}]:[],
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => $('#pl-prev').click());
  navigator.mediaSession.setActionHandler('nexttrack', () => $('#pl-next').click());
});

// ============ КАРАОКЕ ============
$('#pl-lyrics').addEventListener('click', () => {
  const t = state.playerQueue[state.playerIndex];
  if (!t) return;
  openLyricsFor(`${t.artist||''} ${t.title}`, t.title, t.artist);
});
$('#lyrics-close').addEventListener('click', () => $('#lyrics-overlay').classList.add('hidden'));

async function openLyricsFor(q, title, artist) {
  $('#lyrics-overlay').classList.remove('hidden');
  $('#lyrics-header').textContent = `${title} — ${artist}`;
  $('#lyrics-body').innerHTML = `<div class="dim">Ищем текст…</div>`;
  try {
    const r = await api('/api/lyrics?q=' + encodeURIComponent(q));
    if (!r.lines || !r.lines.length) {
      $('#lyrics-body').innerHTML = `<div class="dim">Текст не найден 😔</div>`;
      state.currentLyrics = null;
      return;
    }
    state.currentLyrics = r.lines;
    $('#lyrics-body').innerHTML = r.lines.map((l, i) => `<div class="ln" data-i="${i}" data-t="${l.time||i*3}">${escapeHtml(l.text)}</div>`).join('');
  } catch (e) {
    $('#lyrics-body').innerHTML = `<div class="dim">Ошибка: ${e.message}</div>`;
  }
}

function updateLyricsPosition() {
  if (!state.currentLyrics || $('#lyrics-overlay').classList.contains('hidden')) return;
  const t = audio.currentTime;
  const nodes = $$('#lyrics-body .ln');
  let activeIdx = -1;
  for (let i = 0; i < state.currentLyrics.length; i++) {
    if ((state.currentLyrics[i].time || i*3) <= t) activeIdx = i;
  }
  nodes.forEach((n, i) => {
    n.classList.toggle('active', i === activeIdx);
    n.classList.toggle('past', i < activeIdx);
  });
  const active = nodes[activeIdx];
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============ АРТИСТ ============
async function renderArtist(id) {
  const app = $('#app');
  app.innerHTML = `<div class="dim center" style="padding:60px">Загрузка артиста…</div>`;
  try {
    const a = await api('/api/artist/' + id);
    app.innerHTML = `
      <div class="item-header glass">
        <div class="bg-blur" style="background-image:url('${a.picture}')"></div>
        <div class="item-cover" style="border-radius:50%"><img src="${a.picture}" style="border-radius:50%"></div>
        <div>
          <div class="item-kind">Артист</div>
          <h1 class="item-title">${escapeHtml(a.name)}</h1>
          <div class="item-meta">${a.nb_fan ? a.nb_fan.toLocaleString('ru-RU') + ' поклонников' : ''}</div>
        </div>
      </div>
      <section class="section">
        <div class="section-title"><h2>Популярные треки</h2></div>
        <div class="grid grid-list">
          ${a.top.map((t,i) => `
            <div class="track-row glass" onclick="navigate('/track/${t.id}')">
              <div class="tr-num">${i+1}</div>
              <div class="tr-cover"><img src="${t.cover}" alt=""></div>
              <div><div class="tr-title">${escapeHtml(t.title)}</div><div class="tr-artist">${escapeHtml(t.artist)}</div></div>
              <div class="tr-time">${fmtDur(t.duration)}</div>
              <div class="tr-actions">
                <button class="icon-btn" onclick="event.stopPropagation(); playTrackData(${JSON.stringify(t).replace(/"/g,'&quot;')})">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
            </div>`).join('')}
        </div>
      </section>
      <section class="section">
        <div class="section-title"><h2>Альбомы</h2></div>
        <div class="grid grid-tracks">
          ${a.albums.map(al => `
            <div class="card glass" onclick="navigate('/album/${al.id}')">
              <div class="card-cover"><img src="${al.cover}" alt=""></div>
              <div class="card-title">${escapeHtml(al.title)}</div>
              <div class="card-artist">${al.release_date ? al.release_date.slice(0,4) : ''}</div>
            </div>`).join('')}
        </div>
      </section>
    `;
  } catch (e) {
    app.innerHTML = `<div class="dim center" style="padding:60px">Ошибка: ${e.message}</div>`;
  }
}

// ============ ТОП ============
async function renderTop() {
  const app = $('#app');
  app.innerHTML = `
    <h1 class="page-title">Топы Dreinnify</h1>
    <p class="page-sub">Лучшие треки и альбомы по оценкам сообщества</p>
    <div class="tabs" id="top-tabs">
      <div class="tab active" data-type="track">Треки</div>
      <div class="tab" data-type="album">Альбомы</div>
    </div>
    <div class="tabs" id="top-period">
      <div class="tab" data-p="day">День</div>
      <div class="tab" data-p="week">Неделя</div>
      <div class="tab active" data-p="month">Месяц</div>
      <div class="tab" data-p="all">Всё время</div>
    </div>
    <div id="top-list" class="grid grid-list"></div>
  `;
  const load = async () => {
    const type = $('#top-tabs .tab.active').dataset.type;
    const period = $('#top-period .tab.active').dataset.p;
    const r = await api(`/api/top?type=${type}&period=${period}`);
    if (!r.items.length) { $('#top-list').innerHTML = `<div class="dim center" style="padding:40px">Пока пусто. Будьте первым — поставьте оценку!</div>`; return; }
    $('#top-list').innerHTML = r.items.map((it, i) => `
      <div class="track-row glass" onclick="navigate('/${type}/${it.item_id}')">
        <div class="tr-num" style="font-family:var(--font-display); font-size:18px; font-weight:700; color:${i<3?'var(--gold)':'var(--text-mute)'}">${i+1}</div>
        <div class="tr-cover">${it.item_cover?`<img src="${it.item_cover}">`:''}</div>
        <div><div class="tr-title">${escapeHtml(it.item_title||'')}</div><div class="tr-artist">${escapeHtml(it.item_artist||'')}</div></div>
        <div class="tr-time" style="font-family:var(--font-display); font-weight:700; font-size:16px">${Math.round(it.avg_total)}<span class="dim" style="font-weight:400"> /90</span></div>
        <div class="tr-actions"><span class="chip">${it.cnt} оценок</span></div>
      </div>`).join('');
  };
  $$('#top-tabs .tab').forEach(t => t.addEventListener('click', () => { $$('#top-tabs .tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); load(); }));
  $$('#top-period .tab').forEach(t => t.addEventListener('click', () => { $$('#top-period .tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); load(); }));
  load();
}

// ============ ПРОФИЛЬ ============
async function renderMyProfile() {
  if (!state.user) return openLogin();
  return renderProfile(state.user.telegram_id, true);
}

async function renderProfile(tid, isMe = false) {
  const app = $('#app');
  app.innerHTML = `<div class="dim center" style="padding:60px">Загрузка…</div>`;
  try {
    const data = await api('/api/user/' + tid);
    const u = data.user;
    isMe = isMe || (state.user && String(state.user.telegram_id) === String(tid));
    const avatar = u.photo_url ? `<img src="${u.photo_url}" alt="">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:56px;font-family:var(--font-display);font-weight:700">${(u.first_name||u.username||'?')[0].toUpperCase()}</div>`;
    const avg = data.reviews.length ? Math.round(data.reviews.reduce((a,r)=>a+r.total,0) / data.reviews.length) : '—';

    app.innerHTML = `
      <div class="profile-hero glass">
        <div class="profile-avatar">${avatar}</div>
        <div>
          <div class="profile-name">${escapeHtml(u.first_name || u.username || 'Пользователь')}${u.verified?`<span class="verified-tick">${VERIFIED_SVG}</span>`:''}${u.is_admin?`<span class="chip gold">ADMIN</span>`:''}</div>
          ${u.username?`<div class="profile-handle">@${escapeHtml(u.username)}</div>`:''}
          ${u.bio?`<div class="profile-bio">${escapeHtml(u.bio)}</div>`:''}
          <div class="profile-stats">
            <div class="st"><div class="v">${data.reviews.length}</div><div class="l">оценок</div></div>
            <div class="st"><div class="v">${data.reviews.filter(r=>r.body && r.body.length>=300).length}</div><div class="l">рецензий</div></div>
            <div class="st"><div class="v">${data.favorites.length}</div><div class="l">в избранном</div></div>
            <div class="st"><div class="v">${avg}</div><div class="l">средний балл</div></div>
          </div>
          ${isMe?`<div class="row mt-16">
            <button class="btn btn-ghost btn-sm" onclick="openProfileEdit()">Редактировать</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('avatar-upload').click()">Сменить аватар</button>
            ${!u.verified?`<a href="/verify" data-nav class="btn btn-ghost btn-sm">Верификация</a>`:''}
            <button class="btn btn-danger btn-sm" onclick="logout()">Выйти</button>
            <input type="file" id="avatar-upload" style="display:none" accept="image/*" onchange="uploadAvatar(this.files[0])">
          </div>`:''}
        </div>
      </div>

      <div class="tabs" id="pr-tabs">
        <div class="tab active" data-t="reviews">Оценки и рецензии</div>
        <div class="tab" data-t="favs">Избранное</div>
      </div>

      <div id="pr-list"></div>
    `;

    const renderList = () => {
      const t = $('#pr-tabs .tab.active').dataset.t;
      if (t === 'reviews') {
        $('#pr-list').innerHTML = data.reviews.length ? `<div class="reviews-list">` + data.reviews.map(r => `
          <div class="review-card glass" onclick="navigate('/${r.item_type}/${r.item_id}')">
            <div class="review-head">
              <div class="rv-avatar">${r.item_cover?`<img src="${r.item_cover}" style="border-radius:8px">`:''}</div>
              <div>
                <div class="rv-name">${escapeHtml(r.item_title||'')}</div>
                <div class="rv-date">${escapeHtml(r.item_artist||'')} · ${fmtDate(r.created_at)}</div>
              </div>
              <div class="rv-total">${r.total}<span class="d">/90</span></div>
            </div>
            ${r.title?`<div class="review-title">${escapeHtml(r.title)}</div>`:''}
            ${r.body?`<div class="review-body" style="max-height:100px; overflow:hidden;">${escapeHtml(r.body.slice(0,300))}${r.body.length>300?'…':''}</div>`:''}
          </div>`).join('') + `</div>` : `<div class="dim center" style="padding:40px">Оценок пока нет</div>`;
      } else {
        $('#pr-list').innerHTML = data.favorites.length ? `<div class="grid grid-tracks">` + data.favorites.map(f => `
          <div class="card glass" onclick="navigate('/${f.item_type}/${f.item_id}')">
            <div class="card-cover">${f.item_cover?`<img src="${f.item_cover}" alt="">`:''}</div>
            <div class="card-title">${escapeHtml(f.item_title||'')}</div>
            <div class="card-artist">${escapeHtml(f.item_artist||'')}</div>
          </div>`).join('') + `</div>` : `<div class="dim center" style="padding:40px">В избранном пусто</div>`;
      }
    };
    $$('#pr-tabs .tab').forEach(t => t.addEventListener('click', () => { $$('#pr-tabs .tab').forEach(x=>x.classList.remove('active')); t.classList.add('active'); renderList(); }));
    renderList();
  } catch(e) { app.innerHTML = `<div class="dim center" style="padding:60px">Ошибка: ${e.message}</div>`; }
}

function openProfileEdit() {
  const u = state.user;
  showModal(`
    <h3>Редактировать профиль</h3>
    <div class="form-grid">
      <div><label>Имя</label><input id="ed-name" value="${escapeHtml(u.first_name||'')}"></div>
      <div><label>О себе</label><textarea id="ed-bio" rows="4">${escapeHtml(u.bio||'')}</textarea></div>
      <button class="btn btn-primary btn-block" onclick="saveProfile()">Сохранить</button>
    </div>
  `);
}
async function saveProfile() {
  try {
    const r = await api('/api/me/update', { method: 'POST', body: JSON.stringify({ first_name: $('#ed-name').value, bio: $('#ed-bio').value })});
    state.user = r.user; toast('Сохранено ✓'); closeModal(); renderUserSlot(); render();
  } catch(e){ toast(e.message, true); }
}
async function uploadAvatar(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('avatar', file);
  try {
    const r = await api('/api/me/avatar', { method: 'POST', body: fd });
    state.user = r.user; toast('Аватар обновлён ✓'); renderUserSlot(); render();
  } catch(e){ toast(e.message, true); }
}

// ============ ВЕРИФИКАЦИЯ ============
async function renderVerify() {
  if (!state.user) return openLogin();
  const app = $('#app');
  const { verify_criteria } = await api('/api/criteria');
  app.innerHTML = `
    <h1 class="page-title">Верификация</h1>
    <p class="page-sub">Подтвердите свою медийность — получите статус и красивую галочку рядом с ником.</p>

    <div class="glass" style="padding:24px; border-radius:var(--radius-lg); margin-bottom:24px">
      <h3 style="font-family:var(--font-display); font-size:20px; margin-bottom:12px">Требования</h3>
      <ul style="margin-left:16px; color:var(--text-dim); font-size:14px; line-height:1.7">
        ${verify_criteria.map(v => `<li>${escapeHtml(v)}</li>`).join('')}
      </ul>
    </div>

    ${state.user.verify_status === 'pending' ? `
      <div class="glass center" style="padding:32px; border-radius:var(--radius-lg)">
        <h3 style="font-family:var(--font-display); font-size:22px">⏳ Заявка на рассмотрении</h3>
        <p class="dim mt-8">Мы уведомим вас, когда админ проверит запрос.</p>
      </div>
    ` : state.user.verified ? `
      <div class="glass center" style="padding:32px; border-radius:var(--radius-lg)">
        <div style="font-size:56px">${VERIFIED_SVG.replace(/width="16"/,'width="56"').replace(/height="16"/,'height="56"')}</div>
        <h3 style="font-family:var(--font-display); font-size:22px; margin-top:12px">Вы верифицированы!</h3>
      </div>
    ` : `
      <div class="glass" style="padding:24px; border-radius:var(--radius-lg)">
        <div class="form-grid">
          <div><label>Ссылки на ваши соц. сети (через запятую)</label><input id="v-socials" placeholder="https://instagram.com/... , https://youtube.com/..."></div>
          <div><label>Ссылка на видео-подтверждение (YouTube, Rutube, VK Видео и т.п.)</label><input id="v-video" placeholder="https://..."></div>
          <div><label>Комментарий (необязательно)</label><textarea id="v-comment" rows="3" placeholder="Расскажите о себе, о своей аудитории"></textarea></div>
          <button class="btn btn-primary btn-block" onclick="submitVerify()">Отправить заявку</button>
        </div>
      </div>
    `}
  `;
}
async function submitVerify() {
  const socials = $('#v-socials').value.trim();
  const video_url = $('#v-video').value.trim();
  const comment = $('#v-comment').value.trim();
  if (!video_url) return toast('Укажите ссылку на видео', true);
  try {
    await api('/api/verify/request', { method: 'POST', body: JSON.stringify({ socials, video_url, comment })});
    toast('Заявка отправлена ✓'); await refreshMe(); render();
  } catch(e){ toast(e.message, true); }
}

// ============ АДМИНКА ============
async function renderAdmin() {
  if (!state.user || !state.user.is_admin) { $('#app').innerHTML = `<div class="dim center" style="padding:60px">Доступ запрещён</div>`; return; }
  const app = $('#app');
  app.innerHTML = `
    <h1 class="page-title">Админ-панель</h1>
    <p class="page-sub">Управление платформой Dreinnify</p>
    <div class="tabs" id="ad-tabs">
      <div class="tab active" data-t="stats">Обзор</div>
      <div class="tab" data-t="users">Пользователи</div>
      <div class="tab" data-t="verify">Заявки на верификацию</div>
      <div class="tab" data-t="noms">Номинации</div>
    </div>
    <div id="ad-body"></div>
  `;
  const load = async () => {
    const t = $('#ad-tabs .tab.active').dataset.t;
    if (t === 'stats') return loadAdminStats();
    if (t === 'users') return loadAdminUsers();
    if (t === 'verify') return loadAdminVerify();
    if (t === 'noms') return loadAdminNoms();
  };
  $$('#ad-tabs .tab').forEach(x => x.addEventListener('click', () => { $$('#ad-tabs .tab').forEach(y=>y.classList.remove('active')); x.classList.add('active'); load(); }));
  load();
}
async function loadAdminStats() {
  const s = await api('/api/admin/stats');
  $('#ad-body').innerHTML = `
    <div class="admin-grid">
      <div class="admin-card glass"><div class="l">Пользователей</div><div class="v">${s.users}</div></div>
      <div class="admin-card glass"><div class="l">Оценок / рецензий</div><div class="v">${s.reviews}</div></div>
      <div class="admin-card glass"><div class="l">Верифицированных</div><div class="v">${s.verified}</div></div>
      <div class="admin-card glass"><div class="l">Заявок в ожидании</div><div class="v">${s.pending}</div></div>
    </div>
    <h3 style="font-family:var(--font-display); margin-bottom:12px">Последние оценки</h3>
    <table class="table">
      <tr><th>Пользователь</th><th>Объект</th><th>Балл</th><th>Дата</th></tr>
      ${s.recent.map(r=>`<tr><td>${escapeHtml(r.first_name||r.username||'—')}</td><td><a href="/${r.item_type}/${r.item_id}" data-nav>${escapeHtml(r.item_title||'')}</a></td><td><b>${r.total}</b>/90</td><td>${fmtDate(r.created_at)}</td></tr>`).join('')}
    </table>
  `;
}
async function loadAdminUsers() {
  const s = await api('/api/admin/users');
  $('#ad-body').innerHTML = `
    <table class="table">
      <tr><th>Имя</th><th>@username</th><th>Telegram ID</th><th>Верификация</th><th>Действия</th></tr>
      ${s.users.map(u=>`
        <tr>
          <td><a href="/profile/${u.telegram_id}" data-nav>${escapeHtml(u.first_name||'—')}</a> ${u.verified?VERIFIED_SVG:''}</td>
          <td class="mono">${u.username?'@'+escapeHtml(u.username):''}</td>
          <td class="mono">${u.telegram_id}</td>
          <td><span class="chip">${u.verify_status}</span></td>
          <td>
            <button class="btn btn-sm ${u.verified?'btn-danger':'btn-primary'}" onclick="adminVerify(${u.id}, ${!u.verified})">${u.verified?'Убрать ✓':'Выдать ✓'}</button>
          </td>
        </tr>`).join('')}
    </table>
  `;
}
async function adminVerify(id, value) {
  try { await api(`/api/admin/user/${id}/verify`, { method: 'POST', body: JSON.stringify({ value })}); toast('Обновлено'); loadAdminUsers(); }
  catch(e){ toast(e.message, true); }
}
async function loadAdminVerify() {
  const s = await api('/api/admin/verify-requests');
  $('#ad-body').innerHTML = !s.requests.length ? `<div class="dim center" style="padding:40px">Заявок нет</div>` : `
    <div class="stack">
      ${s.requests.map(r=>`
        <div class="glass" style="padding:20px; border-radius:var(--radius)">
          <div class="row" style="justify-content:space-between">
            <div><b>${escapeHtml(r.first_name||r.username||'—')}</b> <span class="dim">@${escapeHtml(r.username||'')}</span></div>
            <span class="chip">${r.status}</span>
          </div>
          <div class="mt-8"><b>Соц. сети:</b> <span class="dim">${escapeHtml(r.socials||'—')}</span></div>
          <div class="mt-8"><b>Видео:</b> <a href="${r.video_url}" target="_blank" class="dim">${escapeHtml(r.video_url)}</a></div>
          ${r.comment?`<div class="mt-8"><b>Комментарий:</b> <span class="dim">${escapeHtml(r.comment)}</span></div>`:''}
          ${r.status==='pending'?`
            <div class="row mt-16">
              <button class="btn btn-primary btn-sm" onclick="verifyDecision(${r.id}, true)">Одобрить</button>
              <button class="btn btn-danger btn-sm" onclick="verifyDecision(${r.id}, false)">Отклонить</button>
            </div>`:''}
        </div>`).join('')}
    </div>
  `;
}
async function verifyDecision(id, approved) {
  try { await api(`/api/admin/verify-requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ approved })}); toast('Решение принято'); loadAdminVerify(); }
  catch(e){ toast(e.message, true); }
}

async function loadAdminNoms() {
  const s = await api('/api/nominations');
  $('#ad-body').innerHTML = `
    <div class="glass" style="padding:24px; border-radius:var(--radius-lg); margin-bottom:24px">
      <h3 style="font-family:var(--font-display); font-size:20px; margin-bottom:16px">Создать номинацию</h3>
      <div class="form-grid">
        <div><label>Название</label><input id="n-title" placeholder="Артист месяца"></div>
        <div><label>Победитель (для картинки, необязательно)</label><input id="n-winner" placeholder="CUPSIZE"></div>
        <div><label>Описание</label><textarea id="n-desc" rows="2" placeholder="Май 2026"></textarea></div>
        <div class="color-row">
          <div><label>Фон</label><input type="color" id="n-bg" value="#0f0f14"></div>
          <div><label>Текст</label><input type="color" id="n-text" value="#ffffff"></div>
          <div><label>Акцент</label><input type="color" id="n-acc" value="#7c5cff"></div>
        </div>
        <div class="row">
          <button class="btn btn-ghost" onclick="previewNom()">🖼️ Предпросмотр картинки</button>
          <button class="btn btn-primary" onclick="saveNom()">Сохранить номинацию</button>
        </div>
        <div id="n-preview"></div>
      </div>
    </div>
    <h3 style="font-family:var(--font-display); font-size:20px; margin-bottom:16px">Существующие номинации</h3>
    <div class="grid grid-tracks">
      ${s.nominations.map(n=>`
        <div class="card glass" style="cursor:default">
          <div class="nom-preview">${n.image?`<img src="${n.image}" alt="">`:`<div style="width:100%;height:100%;background:${n.bg_color}; display:flex;align-items:center;justify-content:center; color:${n.text_color}; padding:12px; text-align:center">${escapeHtml(n.title)}</div>`}</div>
          <div class="card-title mt-8">${escapeHtml(n.title)}</div>
          <div class="card-artist">${escapeHtml(n.description||'')}</div>
          <button class="btn btn-danger btn-sm mt-8" onclick="delNom(${n.id})">Удалить</button>
        </div>`).join('') || '<div class="dim">Пока нет номинаций</div>'}
    </div>
  `;
}
async function previewNom() {
  try {
    const r = await api('/api/admin/nomination/render', { method:'POST', body: JSON.stringify({
      title: $('#n-title').value, subtitle: $('#n-desc').value, winner: $('#n-winner').value,
      bg_color: $('#n-bg').value, text_color: $('#n-text').value, accent_color: $('#n-acc').value,
    })});
    $('#n-preview').innerHTML = `<div class="nom-preview mt-16"><img src="${r.url}" alt=""></div><input type="hidden" id="n-image" value="${r.url}">`;
  } catch(e){ toast(e.message, true); }
}
async function saveNom() {
  try {
    const image = $('#n-image')?.value || '';
    await api('/api/admin/nomination', { method: 'POST', body: JSON.stringify({
      title: $('#n-title').value, description: $('#n-desc').value,
      bg_color: $('#n-bg').value, text_color: $('#n-text').value, accent_color: $('#n-acc').value, image,
    })});
    toast('Номинация создана'); loadAdminNoms();
  } catch(e){ toast(e.message, true); }
}
async function delNom(id) {
  if (!confirm('Удалить?')) return;
  await api('/api/admin/nomination/' + id, { method: 'DELETE' });
  loadAdminNoms();
}

// ============ АНИМАЦИЯ ТОПБАРА ПРИ СКРОЛЛЕ ============
let lastScroll = 0;
window.addEventListener('scroll', () => {
  const sc = window.scrollY;
  const tb = $('#topbar');
  if (sc < 40) tb.classList.add('collapsed');
  else tb.classList.remove('collapsed');
  lastScroll = sc;
}, { passive: true });

// ============ ГОРЯЧИЕ КЛАВИШИ ============
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault(); openSearch();
  }
  if (e.key === 'Escape') { closeSearch(); closeModal(); $('#lyrics-overlay').classList.add('hidden'); }
});

// Экспортируем в global (для inline onclick)
Object.assign(window, {
  navigate, openLogin, logout, playTrackData, playTrackById, playAlbumTracks, openAlbumAndPlay, playTrack: playTrackData,
  toggleFav, submitReview, deleteReview, clearRateForm, showCriteria, openLyricsFor,
  openProfileEdit, saveProfile, uploadAvatar, submitVerify,
  adminVerify, verifyDecision, previewNom, saveNom, delNom,
  closeSearch, closeModal,
});

// ============ ИНИЦИАЛИЗАЦИЯ ============
(async function init() {
  try { state.config = await api('/api/config'); } catch {}
  await refreshMe();
  render();
})();

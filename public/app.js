// public/app.js
// SOKOLENOK shared frontend logic.
// All API calls go through `api`, all DOM helpers through `$/$$`, toasts via `toast.*`.
// Page-specific code lives in DOMContentLoaded handlers gated by page id.

(() => {
'use strict';

// ============ tiny helpers ============
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function relativeTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} д назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtNumber(n, frac = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(n);
}

function fmtPrice(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const code = String(currency || 'RUB').toUpperCase();
  const symbols = { RUB: '₽', USD: '$', EUR: '€' };
  const frac = code === 'RUB' ? 0 : 2;
  const formatted = fmtNumber(value, frac);
  return code === 'RUB' ? `${formatted} ${symbols.RUB}` : `${symbols[code] || ''}${formatted}`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function encId(id) {
  return encodeURIComponent(String(id || ''));
}

function isSteamId(id) {
  return /^\d{17}$/.test(String(id || ''));
}

function isSiteUserId(id) {
  return isSteamId(id) || /^tg:\d+$/.test(String(id || ''));
}

function publicUserName(user, fallback = 'Telegram-пользователь') {
  const raw = String(user?.name || user?.personaname || user?.persona_name || user?.steam_id || user?.steamid || '').trim();
  if (!raw || /^tg:\d+$/.test(raw)) return fallback;
  return raw;
}

// ============ first-party conversion tracking ============
function readCampaign() {
  const p = new URLSearchParams(location.search);
  const fresh = { source: p.get('utm_source'), medium: p.get('utm_medium'), campaign: p.get('utm_campaign'), content: p.get('utm_content'), term: p.get('utm_term') };
  try {
    if (fresh.source || fresh.medium || fresh.campaign || fresh.content || fresh.term) localStorage.setItem('sok:utm', JSON.stringify(fresh));
    return JSON.parse(localStorage.getItem('sok:utm') || 'null') || fresh;
  } catch (_) { return fresh; }
}
function track(kind, extra = {}) {
  const payload = { kind, page: location.pathname, referrer: document.referrer ? (() => { try { return new URL(document.referrer).hostname; } catch (_) { return ''; } })() : '', utm: readCampaign(), ...extra };
  fetch('/api/track', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(() => {});
}

// ============ api wrapper ============
const api = {
  async request(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok && !body) throw new Error(`HTTP ${res.status}`);
    return body;
  },
  me() { return this.request('/api/me'); },
  completeOnboarding() { return this.request('/api/onboarding/complete', { method: 'POST' }); },
  health() { return this.request('/api/health'); },
  resolve(target) { return this.request(`/api/resolve?target=${encodeURIComponent(target)}`); },
  // Accept SteamID64, vanity, full profile URL, or short URL. Returns steamid or null.
  async resolveAny(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    if (isSiteUserId(s)) return s;
    const r = await this.resolve(s).catch(() => null);
    return r?.ok && r.steamid ? r.steamid : null;
  },
  profile(steamid) { return this.request(`/api/profile/${encId(steamid)}`); },
  inventory(steamid, opts = {}) {
    const q = new URLSearchParams();
    if (opts.currency) q.set('currency', opts.currency);
    if (opts.noPrices) q.set('no_prices', '1');
    if (opts.cachedOk) q.set('cached_ok', '1');
    if (opts.force) q.set('force', '1');
    return this.request(`/api/inventory/${encId(steamid)}${q.toString() ? '?' + q : ''}`);
  },
  inventoryHistory(steamid) { return this.request(`/api/inventory/history?steamid=${encId(steamid)}`); },
  news(count = 10) {
    // News can be slow if Steam is having a bad day — race against a 10s timeout
    return Promise.race([
      this.request(`/api/news?count=${count}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('news-timeout')), 10000))
    ]);
  },
  stats(steamid) { return this.request(`/api/stats/${encId(steamid)}`); },
  bans(steamid)    { return this.request(`/api/playerbans/${encId(steamid)}`); },
  leetify(steamid) { return this.request(`/api/leetify/${encId(steamid)}`); },
  reputation: {
    get(steamid)  { return api.request(`/api/reputation/${encId(steamid)}`); },
    vote(steamid, categories, comment) {
      return api.request(`/api/reputation/${encId(steamid)}`, {
        method: 'POST', body: JSON.stringify({ categories, comment: comment || null })
      });
    },
    remove(steamid) {
      return api.request(`/api/reputation/${encId(steamid)}`, { method: 'DELETE' });
    }
  },
  feed(scope = 'all') { return this.request(`/api/feed?scope=${encodeURIComponent(scope)}`); },
  publics() { return this.request('/api/publics'); },
  createPublic(data) { return this.request('/api/publics', { method: 'POST', body: JSON.stringify(data) }); },
  publicDetail(id) { return this.request(`/api/publics/${encodeURIComponent(id)}`); },
  updatePublic(id, data) { return this.request(`/api/publics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  deletePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  createPost(data) { return this.request('/api/posts', { method: 'POST', body: JSON.stringify(data) }); },
  updatePost(id, data) { return this.request(`/api/posts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  deletePost(id) { return this.request(`/api/posts/${id}`, { method: 'DELETE' }); },
  votePoll(id, option) { return this.request(`/api/posts/${id}/vote`, { method: 'POST', body: JSON.stringify({ option }) }); },
  pinPost(id) { return this.request(`/api/posts/${id}/pin`, { method: 'POST' }); },
  unpinPost(id) { return this.request(`/api/posts/${id}/unpin`, { method: 'POST' }); },
  recommendCommunities() { return this.request('/api/publics/recommend', { method: 'GET' }); },
  publicStats(id) { return this.request(`/api/publics/${encodeURIComponent(id)}/stats`); },
  deleteMessage(id) { return this.request(`/api/messages/msg/${id}`, { method: 'DELETE' }); },
  reactToMessage(msgId, emoji) { return this.request(`/api/messages/reactions/${msgId}`, { method: 'POST', body: JSON.stringify({ emoji }) }); },
  authConfig() { return this.request('/api/auth/config'); },
  authMethods() { return this.request('/api/auth/methods'); },
  authUnbind(provider) { return this.request('/api/auth/unbind', { method: 'POST', body: JSON.stringify({ provider }) }); },
  likePost(id) { return this.request(`/api/posts/${id}/like`, { method: 'POST' }); },
  unlikePost(id) { return this.request(`/api/posts/${id}/like`, { method: 'DELETE' }); },
  viewPost(id) { return this.request(`/api/posts/${id}/view`, { method: 'POST' }); },
  listComments(id) { return this.request(`/api/posts/${id}/comments`); },
  addComment(id, body) { return this.request(`/api/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }); },
  deleteComment(postId, commentId) { return this.request(`/api/posts/${postId}/comments/${commentId}`, { method: 'DELETE' }); },
  recommendFriends() { return this.request('/api/friends/recommend'); },
  steamFriendsOnSite() { return this.request('/api/friends/steam'); },
  presence(ids) { return this.request('/api/presence', { method: 'POST', body: JSON.stringify({ ids }) }); },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    return res.json().catch(() => ({ ok: false }));
  },
  subscribePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}/subscribe`, { method: 'POST' }); },
  unsubscribePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}/subscribe`, { method: 'DELETE' }); },
  friends() { return this.request('/api/friends'); },
  friendStatus(id) { return this.request(`/api/friends/${encId(id)}`); },
  friendsOf(id) { return this.request(`/api/friends/${encId(id)}/list`); },
  friendRequest(id) { return this.request(`/api/friends/${encId(id)}/request`, { method: 'POST' }); },
  friendAccept(id) { return this.request(`/api/friends/${encId(id)}/accept`, { method: 'POST' }); },
  friendRemove(id) { return this.request(`/api/friends/${encId(id)}`, { method: 'DELETE' }); },
  blocks() { return this.request('/api/blocks'); },
  block(id) { return this.request(`/api/blocks/${encId(id)}`, { method: 'POST' }); },
  unblock(id) { return this.request(`/api/blocks/${encId(id)}`, { method: 'DELETE' }); },
  conversations() { return this.request('/api/conversations'); },
  messages(id) { return this.request(`/api/messages/${encId(id)}`); },
  sendMessage(id, text, attachment) {
    const body = attachment ? { text: text || '', attachment } : { text };
    return this.request(`/api/messages/${encId(id)}`, { method: 'POST', body: JSON.stringify(body) });
  },
  report(target_type, target_id, reason) {
    return this.request('/api/report', { method: 'POST', body: JSON.stringify({ target_type, target_id, reason }) });
  },
  admin: {
    stats() { return api.request('/api/admin/stats'); },
    analytics(days = 30) { return api.request(`/api/admin/analytics?days=${days}`); },
    reports(status = 'open') { return api.request(`/api/admin/reports?status=${status}`); },
    resolveReport(id, status) { return api.request(`/api/admin/reports/${id}`, { method: 'POST', body: JSON.stringify({ status }) }); },
    bans() { return api.request('/api/admin/bans'); },
    ban(id, reason) { return api.request(`/api/admin/ban/${id}`, { method: 'POST', body: JSON.stringify({ reason }) }); },
    unban(id) { return api.request(`/api/admin/unban/${id}`, { method: 'POST' }); },
    publics() { return api.request('/api/admin/publics'); },
    deletePublic(id) { return api.request(`/api/admin/public/${encodeURIComponent(id)}/delete`, { method: 'POST' }); },
    verifyPublic(id, on) { return api.request(`/api/admin/public/${encodeURIComponent(id)}/${on ? 'verify' : 'unverify'}`, { method: 'POST' }); },
    posts() { return api.request('/api/admin/posts'); },
    deletePost(id) { return api.request(`/api/admin/post/${id}/delete`, { method: 'POST' }); },
    moderators() { return api.request('/api/admin/moderators'); },
    addModerator(id) { return api.request(`/api/admin/moderator/${id}/add`, { method: 'POST' }); },
    removeModerator(id) { return api.request(`/api/admin/moderator/${id}/remove`, { method: 'POST' }); },
    roles() { return api.request('/api/admin/roles'); },
    createRole(data) { return api.request('/api/admin/roles', { method: 'POST', body: JSON.stringify(data) }); },
    updateRole(id, data) { return api.request(`/api/admin/roles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }); },
    deleteRole(id) { return api.request(`/api/admin/roles/${id}`, { method: 'DELETE' }); },
    addRoleMember(id, sid) { return api.request(`/api/admin/roles/${id}/members/${sid}`, { method: 'POST' }); },
    removeRoleMember(id, sid) { return api.request(`/api/admin/roles/${id}/members/${sid}`, { method: 'DELETE' }); }
  },
  publicEditors(pid) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors`); },
  addPublicEditor(pid, id) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors/${encId(id)}`, { method: 'POST' }); },
  removePublicEditor(pid, id) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors/${encId(id)}`, { method: 'DELETE' }); },
  faceit(steamid, opts = {}) {
    const q = new URLSearchParams();
    if (opts.nickname) q.set('nickname', opts.nickname);
    if (opts.matches) q.set('matches', String(opts.matches));
    const qs = q.toString();
    return this.request(`/api/faceit/${encId(steamid)}${qs ? '?' + qs : ''}`);
  },
  prices(names, currency = 'RUB') {
    const q = new URLSearchParams({ names: names.join(','), currency });
    return this.request(`/api/prices?${q}`);
  },
  priceHistory(name, currency = 'RUB', days = 30) {
    const q = new URLSearchParams({ name, currency, days });
    return this.request(`/api/price-history?${q}`);
  },
  priceMovers(names, currency = 'RUB', days = 30) {
    return this.request('/api/price-movers', {
      method: 'POST',
      body: JSON.stringify({ names, currency, days })
    });
  },
  activityPing() { return this.request('/api/presence/ping', { method: 'POST' }); },
  watchlist: {
    list() { return api.request('/api/watchlist'); },
    add(data) { return api.request('/api/watchlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data) }); },
    remove(market_name) { return api.request('/api/watchlist', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ market_name }) }); }
  },
  settings: {
    get() { return api.request('/api/settings'); },
    save(data) { return api.request('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data) }); }
  }
};

// ============ toast ============
const toast = {
  _wrap: null,
  _ensure() {
    if (this._wrap) return this._wrap;
    this._wrap = el('div', { class: 'toast-wrap' });
    document.body.appendChild(this._wrap);
    return this._wrap;
  },
  show(message, kind = 'ok', ms = 3200) {
    const t = el('div', { class: `toast ${kind}` }, message);
    this._ensure().appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 320); }, ms);
  },
  ok(m) { this.show(m, 'ok'); },
  err(m) { this.show(m, 'err'); },
  warn(m) { this.show(m, 'warn'); }
};

function tellServiceWorkerActiveMessagePeer(peer) {
  try {
    if (!navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: 'sok:active-message-peer',
      peer: peer || null
    });
  } catch (_) {}
}

// ============ sidebar + main toolbar ============
// Returns the `me` object so callers can use logged_in state immediately.
async function renderTopbar(active = '') {
  const me = await api.me().catch(() => ({ logged_in: false }));
  window.__me = me;
  try {
    if (me.logged_in && sessionStorage.getItem('sok:await_login') === '1') {
      sessionStorage.removeItem('sok:await_login');
      track('steam_login_success');
    }
  } catch (_) {}
  if (active !== 'messages') {
    document.body.classList.remove('msgr-thread-open');
    tellServiceWorkerActiveMessagePeer(null);
  }
  renderSidebar(active, me);
  renderMainToolbar(me);
  renderSocialTopbar(me);
  ensureMobileNav();
  // (FAB removed: support is now in sidebar/me menu)
  document.getElementById('support-fab')?.remove();
  // First-login consent gate (152-ФЗ explicit consent)
  if (me.logged_in && me.consented === false) showConsentGate();
  else if (me.logged_in && !me.settings?.onboarding_done) setTimeout(() => showOnboardingTour(), 500);
  // Background polling for unread messages (stops on next page change naturally)
  ensureUnreadPolling();
  // Realtime channel — push messages and notifications without polling
  if (me.logged_in) {
    ensureActivityHeartbeat();
    ensureRealtime();
    // Register service worker for Web Push (no-op if browser doesn't support it)
    ensureServiceWorker();
    // Show a non-intrusive banner inviting user to enable push notifications
    // (only if not already enabled and not dismissed recently)
    setTimeout(() => maybeShowPushOptIn(), 1500);
  }
  return me;
}


// First-login onboarding: deliberately lightweight and isolated from page logic.
let _tourOpen = false;
function showOnboardingTour() {
  if (_tourOpen || document.querySelector('.sok-tour')) return;
  _tourOpen = true;
  const steps = [
    ['Добро пожаловать в SOKOLENOK', 'Здесь можно проверить профиль игрока CS2, узнать стоимость инвентаря и поделиться результатом.'],
    ['Проверка игрока', 'Вставьте SteamID или ссылку в поиск — публичный профиль откроется без передачи пароля.'],
    ['Инвентарь и цены', 'В разделе «Инвентарь» показываются доступные предметы и их оценка в выбранной валюте.'],
    ['Друзья и сообщения', 'Добавляйте знакомых игроков и отправляйте им найденные профили прямо внутри сайта.'],
    ['Делитесь карточкой', 'Кнопка «Поделиться» создаёт красивое превью для Telegram, VK и Discord.']
  ];
  let n = 0;
  const overlay = el('div', { class: 'sok-tour' });
  const card = el('div', { class: 'sok-tour-card' });
  const count = el('div', { class: 'sok-tour-count' });
  const title = el('h2', { class: 'sok-tour-title' });
  const text = el('p', { class: 'sok-tour-text' });
  const next = el('button', { class: 'btn', type: 'button' });
  const close = async () => { await api.completeOnboarding().catch(() => null); overlay.remove(); _tourOpen = false; };
  const draw = () => { count.textContent = `${n + 1} / ${steps.length}`; title.textContent = steps[n][0]; text.textContent = steps[n][1]; next.textContent = n === steps.length - 1 ? 'Начать' : 'Далее'; };
  next.addEventListener('click', () => { if (n < steps.length - 1) { n++; draw(); } else close(); });
  const skip = el('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Пропустить');
  card.append(count, title, text, el('div', { class: 'sok-tour-actions' }, skip, next)); overlay.appendChild(card); document.body.appendChild(overlay); draw();
}

// ============ Push opt-in banner ============
// Shows a friendly banner at the top of the page inviting the user to enable
// push notifications. Suppressed when:
//   - browser doesn't support push
//   - permission is already granted (or denied — no point asking again)
//   - user has dismissed within the last 7 days
//   - on iOS Safari outside PWA mode (push impossible there)
async function maybeShowPushOptIn() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission !== 'default') return; // granted → no need; denied → won't help

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    // On iOS outside PWA → silently skip (we show the same hint in /settings).
    if (isIos && !isStandalone) return;

    // Respect dismissal
    const dismissedAt = Number(localStorage.getItem('sok:push-prompt-dismissed') || 0);
    if (dismissedAt && Date.now() - dismissedAt < 7 * 24 * 3600 * 1000) return;
    if (localStorage.getItem('sok:push-prompt-never') === '1') return;

    // Maybe already subscribed but permission lost? Belt-and-suspenders.
    const alreadyEnabled = await window.__push.isEnabled().catch(() => false);
    if (alreadyEnabled) return;

    showPushOptInBanner();
  } catch (_) { /* don't let opt-in errors break the page */ }
}

function showPushOptInBanner() {
  if (document.getElementById('push-optin-banner')) return;
  const banner = el('div', { id: 'push-optin-banner', class: 'push-banner' },
    el('div', { class: 'push-banner-icon' }, '🔔'),
    el('div', { class: 'push-banner-text' },
      el('div', { class: 'push-banner-title' }, 'Включить уведомления?'),
      el('div', { class: 'push-banner-desc' }, 'Получайте сообщения и комменты к вашим постам даже когда сайт закрыт.')
    ),
    el('div', { class: 'push-banner-actions' },
      el('button', { class: 'btn btn-primary', id: 'push-banner-yes' }, 'Включить'),
      el('button', { class: 'btn btn-ghost btn-sm', id: 'push-banner-later' }, 'Позже')
    ),
    el('button', { class: 'push-banner-close', id: 'push-banner-close', title: 'Больше не показывать', 'aria-label': 'Закрыть' }, '×')
  );
  document.body.appendChild(banner);
  // Animate in
  requestAnimationFrame(() => banner.classList.add('show'));

  const dismiss = (forever) => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 250);
    if (forever) { try { localStorage.setItem('sok:push-prompt-never', '1'); } catch (_) {} }
    else { try { localStorage.setItem('sok:push-prompt-dismissed', String(Date.now())); } catch (_) {} }
  };

  $('#push-banner-yes').addEventListener('click', async () => {
    const btn = $('#push-banner-yes');
    btn.disabled = true; btn.textContent = 'Подключаем…';
    const r = await window.__push.enable();
    if (r.ok) {
      toast.ok('Уведомления включены');
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 250);
      try { localStorage.removeItem('sok:push-prompt-dismissed'); } catch (_) {}
    } else if (r.status === 'denied') {
      toast.err('Уведомления заблокированы в браузере. Разрешите их в настройках сайта.');
      dismiss(false);
    } else {
      toast.err('Не удалось включить: ' + (r.error || r.status));
      btn.disabled = false; btn.textContent = 'Включить';
    }
  });
  $('#push-banner-later').addEventListener('click', () => dismiss(false));
  $('#push-banner-close').addEventListener('click', () => dismiss(true));
}

// ============ Service Worker / Web Push ============
let _swRegistration = null;
async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (_swRegistration) return _swRegistration;
  try {
    _swRegistration = await navigator.serviceWorker.register('/sw.js?v=50.15', { scope: '/', updateViaCache: 'none' });
    _swRegistration.update?.().catch(() => null);
    return _swRegistration;
  } catch (e) {
    console.warn('[sw] registration failed:', e?.message);
    return null;
  }
}

// Convert base64url-encoded VAPID public key to Uint8Array (PushManager wants raw)
function urlBase64ToUint8Array(b64url) {
  const padding = '='.repeat((4 - b64url.length % 4) % 4);
  const base64 = (b64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buf = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) buf[i] = rawData.charCodeAt(i);
  return buf;
}

// Returns:
//   'unsupported' — browser doesn't have Push API
//   'denied'      — user blocked notifications system-wide
//   'subscribed'  — already subscribed (and we re-sent the sub to be safe)
//   'subscribed-new' — freshly subscribed
//   'error'       — something else went wrong (e.g. VAPID misconfigured)
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, status: 'unsupported' };
  }
  // iOS Safari: must be installed as PWA (display-mode: standalone) to allow push
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isIos && !isStandalone) {
    return { ok: false, status: 'ios-not-standalone' };
  }

  if (Notification.permission === 'denied') return { ok: false, status: 'denied' };

  const reg = await ensureServiceWorker();
  if (!reg) return { ok: false, status: 'error', error: 'sw-failed' };
  // Wait for the SW to be active — needed for PushManager.subscribe
  if (reg.installing || reg.waiting) {
    await new Promise(resolve => {
      const check = () => { if (reg.active) resolve(); };
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => { if (sw.state === 'activated') resolve(); });
      });
      // Fallback timeout
      setTimeout(resolve, 3000);
      check();
    });
  }

  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, status: 'denied' };
  }

  // Get VAPID public key from server
  const keyResp = await fetch('/api/push/key').then(r => r.json()).catch(() => null);
  if (!keyResp?.ok || !keyResp.publicKey) {
    return { ok: false, status: 'error', error: 'no-vapid-key' };
  }
  const applicationServerKey = urlBase64ToUint8Array(keyResp.publicKey);

  let sub = await reg.pushManager.getSubscription();
  let fresh = false;
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      fresh = true;
    } catch (e) {
      return { ok: false, status: 'error', error: String(e?.message || e) };
    }
  }

  // Send subscription to server (idempotent)
  const subJson = sub.toJSON();
  await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subJson })
  }).catch(() => {});

  return { ok: true, status: fresh ? 'subscribed-new' : 'subscribed' };
}

async function disablePush() {
  if (!('serviceWorker' in navigator)) return { ok: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { ok: true };
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { ok: true };
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (_) {}
  await fetch('/api/push/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint })
  }).catch(() => {});
  return { ok: true };
}

async function isPushEnabled() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub && Notification.permission === 'granted';
}

// Expose for /settings page
window.__push = { enable: enablePush, disable: disablePush, isEnabled: isPushEnabled };

// ============ realtime (WebSocket with auto-reconnect + polling fallback) ============
// We keep a single connection per tab. Other modules subscribe via
// window.addEventListener('sok:ws', e => ...) — e.detail is the parsed message.
// window.__wsAlive is a boolean other code can check (e.g. message polling
// skips its fetch when WS is delivering messages live).

let _ws = null;
let _wsReconnectTimer = null;
let _wsReconnectAttempt = 0;
let _wsClosedByUs = false;

window.__wsAlive = false;

function ensureRealtime() {
  if (_ws && (_ws.readyState === 0 || _ws.readyState === 1)) return; // already connecting/open
  if (_wsClosedByUs) return;
  if (typeof WebSocket === 'undefined') return; // ancient browser → polling will handle it

  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;

  try { _ws = new WebSocket(url); }
  catch (_) { scheduleWsReconnect(); return; }

  _ws.addEventListener('open', () => {
    window.__wsAlive = true;
    _wsReconnectAttempt = 0;
    window.dispatchEvent(new CustomEvent('sok:ws:open'));
  });

  _ws.addEventListener('close', () => {
    window.__wsAlive = false;
    window.dispatchEvent(new CustomEvent('sok:ws:close'));
    if (!_wsClosedByUs) scheduleWsReconnect();
  });

  _ws.addEventListener('error', () => {
    // close event will follow; just mark unhealthy so polling can take over
    window.__wsAlive = false;
  });

  _ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (!m || !m.type) return;
    window.dispatchEvent(new CustomEvent('sok:ws', { detail: m }));
  });

  // Application-level ping every 25s — keeps NAT/proxy from killing the idle socket
  if (_ws._pingTimer) clearInterval(_ws._pingTimer);
  _ws._pingTimer = setInterval(() => {
    if (_ws && _ws.readyState === 1) {
      try { _ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    }
  }, 25000);
}

function scheduleWsReconnect() {
  if (_wsReconnectTimer) return;
  // Exponential backoff capped at 30s: 1, 2, 4, 8, 16, 30, 30, …
  const delay = Math.min(30000, 1000 * Math.pow(2, _wsReconnectAttempt));
  _wsReconnectAttempt++;
  _wsReconnectTimer = setTimeout(() => {
    _wsReconnectTimer = null;
    ensureRealtime();
  }, delay);
}

// Resume on tab focus — most disconnects happen when the laptop sleeps
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !window.__wsAlive) {
    _wsReconnectAttempt = 0;
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    ensureRealtime();
  }
});

// Anything that bumps unread (new message arriving, new notification) → refresh badges.
// Page-specific listeners (chat, /notifications) attach their own handlers on top.
window.addEventListener('sok:ws', (ev) => {
  const m = ev.detail;
  if (!m) return;
  if (m.type === 'message:new' || m.type === 'notification:new') {
    // Tiny debounce: bunch of events arriving together → one fetch
    if (window._wsBadgeBounce) clearTimeout(window._wsBadgeBounce);
    window._wsBadgeBounce = setTimeout(() => {
      window._wsBadgeBounce = null;
      if (typeof refreshUnreadBadge === 'function') refreshUnreadBadge();
    }, 150);
  }
});

let _unreadTimer = null;
function ensureUnreadPolling() {
  if (_unreadTimer) return;
  const startTimer = () => {
    if (_unreadTimer) clearInterval(_unreadTimer);
    // 15s base; when WS is healthy, back off to 60s (it's just a safety net then)
    const interval = window.__wsAlive ? 60000 : 15000;
    _unreadTimer = setInterval(() => { refreshUnreadBadge(); }, interval);
  };
  startTimer();
  window.addEventListener('sok:ws:open', startTimer);
  window.addEventListener('sok:ws:close', startTimer);
  // Pause polling when tab is hidden, resume when visible (battery + bandwidth saving)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (_unreadTimer) { clearInterval(_unreadTimer); _unreadTimer = null; } }
    else if (!_unreadTimer) { refreshUnreadBadge(); startTimer(); }
  });
}

let _activityStarted = false;
let _lastActivityPing = 0;
function ensureActivityHeartbeat() {
  if (_activityStarted) return;
  _activityStarted = true;
  const ping = (force = false) => {
    if (document.hidden || !document.hasFocus()) return;
    const now = Date.now();
    if (!force && now - _lastActivityPing < 45000) return;
    _lastActivityPing = now;
    api.activityPing().catch(() => {});
  };
  const onActive = () => ping(false);
  window.addEventListener('focus', () => ping(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(() => ping(true), 150);
  });
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'mousemove']) {
    window.addEventListener(ev, onActive, { passive: true });
  }
  setInterval(() => ping(false), 30000);
  setTimeout(() => ping(true), 500);
}

// Floating "Support" button (bottom-right) for logged-in users.
// Anti-scam explainer before redirecting to Steam OpenID.
function steamLogin(ev) {
  track('steam_login_clicked');
  try { sessionStorage.setItem('sok:await_login', '1'); } catch (_) {}
  if (ev) ev.preventDefault();
  const host = el('div', { id: 'modal-host', class: 'modal-host' });
  const close = () => host.remove();
  const go = () => { location.href = '/auth/steam'; };
  const dialog = el('div', { class: 'modal-dialog', style: { maxWidth: '420px' } },
    el('div', { class: 'modal-body', style: { textAlign: 'center', paddingTop: '24px' } },
      el('div', { class: 'steam-explain-ico', html:
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0a12 12 0 0 0-11.93 11.06l6.43 2.66a3.4 3.4 0 0 1 1.92-.6h.17l2.85-4.13v-.06a4.55 4.55 0 1 1 4.55 4.55h-.1l-4.07 2.9v.13a3.41 3.41 0 0 1-6.79.5L.16 14.7A12 12 0 1 0 12 0Z"/></svg>' }),
      el('div', { class: 'steam-explain-title' }, 'Вход через Steam'),
      el('div', { class: 'steam-explain-text' },
        'Сейчас откроется ', el('b', null, 'официальная страница Steam'), '. Это безопасно:'),
      el('ul', { class: 'steam-explain-list' },
        el('li', null, '🔒 Мы ', el('b', null, 'не видим и не получаем ваш пароль'), ' — его вводите только на сайте Steam.'),
        el('li', null, '✅ Это стандартный вход Steam, как на маркетах и Faceit.'),
        el('li', null, '👤 Нужен только чтобы подтвердить, что аккаунт ваш.')
      )
    ),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Отмена'),
      el('button', { class: 'btn steam-explain-go', type: 'button', onclick: go }, 'Продолжить в Steam')
    )
  );
  host.appendChild(dialog);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  document.body.appendChild(host);
  return false;
}

// Universal player search: accepts SteamID64, Steam URL, vanity, or persona name.
// Shows live suggestions from our user base; for direct IDs/URLs opens lookup immediately.
function openSearchModal() {
  const input = el('input', { class: 'modal-input', placeholder: 'Игроки, сообщества, посты, ссылка Steam…', autocomplete: 'off' });
  const hint = el('div', { class: 'modal-hint' }, 'Ищет по никам, сообществам и тексту постов. Можно вставить ссылку Steam, ник или SteamID.');
  const results = el('div', { class: 'search-results' });
  const open = (url) => { location.href = url; };
  let lastQ = '', debounce = null;

  // Helper: wrap matched substring with <mark>; HTML-safe.
  const highlight = (text, q) => {
    const t = String(text || '');
    const lower = t.toLowerCase(), needle = q.toLowerCase();
    const i = lower.indexOf(needle);
    if (i < 0) return [document.createTextNode(t)];
    return [
      document.createTextNode(t.slice(0, i)),
      el('mark', { class: 'search-hl' }, t.slice(i, i + needle.length)),
      document.createTextNode(t.slice(i + needle.length))
    ];
  };

  const renderSection = (title, items, builder) => {
    if (!items?.length) return null;
    const sec = el('div', { class: 'search-section' });
    sec.appendChild(el('div', { class: 'search-section-h' }, title));
    for (const it of items) sec.appendChild(builder(it));
    return sec;
  };

  const runSearch = async () => {
    const q = input.value.trim();
    if (q === lastQ) return;
    lastQ = q;
    if (!q) { results.innerHTML = ''; return; }

    // Looks like ID / URL → resolve directly
    if (/^\d{17}$/.test(q) || /steamcommunity\.com/.test(q)) {
      results.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Открываем…</div>';
      const id = await api.resolveAny(q);
      if (id) open(`/lookup?steamid=${encId(id)}`);
      else { results.innerHTML = ''; toast.err('Не нашли такого игрока'); }
      return;
    }
    if (q.length < 2) { results.innerHTML = ''; return; }

    results.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Ищем…</div>';
    const r = await api.request(`/api/search?q=${encodeURIComponent(q)}`).catch(() => null);
    results.innerHTML = '';
    if (!r?.ok) { results.appendChild(el('div', { class: 'search-empty' }, 'Ошибка поиска')); return; }

    const total = (r.users?.length || 0) + (r.publics?.length || 0) + (r.posts?.length || 0);
    if (!total) {
      results.appendChild(el('div', { class: 'search-empty' },
        'Ничего не нашли. ',
        el('button', { class: 'search-try-vanity', type: 'button', onclick: async () => {
          const id = await api.resolveAny(q);
          if (id) open(`/lookup?steamid=${encId(id)}`);
          else toast.err('Не вышло резолвить как ник Steam');
        } }, 'Попробовать как ник Steam')
      ));
      return;
    }

    // Users
    const usersSec = renderSection(`👤 Игроки (${r.users.length})`, r.users, u => {
      const row = el('button', { class: 'search-result', type: 'button',
        onclick: () => open(`/lookup?steamid=${encId(u.steam_id)}`) });
      const ava = el('div', { class: 'search-result-ava' });
      if (u.avatar) {
        const img = el('img', { src: u.avatar, alt: '' });
        img.onerror = function () { this.remove(); ava.textContent = (u.persona_name || '?').slice(0, 1).toUpperCase(); };
        ava.appendChild(img);
      } else ava.textContent = (u.persona_name || '?').slice(0, 1).toUpperCase();
      row.appendChild(ava);
      const info = el('div', { class: 'search-result-info' });
      const name = el('div', { class: 'search-result-name' });
      for (const n of highlight(u.persona_name || u.steam_id, q)) name.appendChild(n);
      info.appendChild(name);
      info.appendChild(el('div', { class: 'search-result-id' }, u.steam_id));
      row.appendChild(info);
      return row;
    });
    if (usersSec) results.appendChild(usersSec);

    // Publics
    const pubSec = renderSection(`👥 Сообщества (${r.publics.length})`, r.publics, p => {
      const row = el('button', { class: 'search-result', type: 'button',
        onclick: () => open(`/feed?public=${encodeURIComponent(p.id)}`) });
      const ava = el('div', { class: 'search-result-ava' });
      if (p.avatar) {
        const img = el('img', { src: p.avatar, alt: '' });
        img.onerror = function () { this.remove(); ava.textContent = (p.name || '?').slice(0, 1).toUpperCase(); };
        ava.appendChild(img);
      } else ava.textContent = (p.name || '?').slice(0, 1).toUpperCase();
      row.appendChild(ava);
      const info = el('div', { class: 'search-result-info' });
      const name = el('div', { class: 'search-result-name' });
      for (const n of highlight(p.name, q)) name.appendChild(n);
      info.appendChild(name);
      if (p.description) {
        const desc = el('div', { class: 'search-result-id' });
        for (const n of highlight(p.description, q)) desc.appendChild(n);
        info.appendChild(desc);
      }
      row.appendChild(info);
      return row;
    });
    if (pubSec) results.appendChild(pubSec);

    // Posts
    const postSec = renderSection(`📝 Посты (${r.posts.length})`, r.posts, p => {
      const row = el('button', { class: 'search-result search-result-post', type: 'button',
        onclick: () => open(`/feed?public=${encodeURIComponent(p.public_id)}#post-${p.id}`) });
      const info = el('div', { class: 'search-result-info', style: { flex: 1 } });
      if (p.title) {
        const t = el('div', { class: 'search-result-name' });
        for (const n of highlight(p.title, q)) t.appendChild(n);
        info.appendChild(t);
      }
      const snip = el('div', { class: 'search-result-snippet' });
      for (const n of highlight(p.snippet, q)) snip.appendChild(n);
      info.appendChild(snip);
      info.appendChild(el('div', { class: 'search-result-id' }, '· ' + (p.public_name || '')));
      row.appendChild(info);
      return row;
    });
    if (postSec) results.appendChild(postSec);
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounce); runSearch(); }
  });

  openModal('Поиск', [hint, input, results], async () => true, 'Закрыть');
  setTimeout(() => input.focus(), 50);
}

function openSupportModal() {
  const msg = el('textarea', { class: 'modal-input', rows: '5', maxlength: '1000',
    placeholder: 'Опишите проблему или вопрос. Чем подробнее — тем быстрее поможем.' });
  openModal('Связь с поддержкой', [
    el('div', { class: 'modal-hint', style: { marginBottom: '4px' } },
      'Сообщение придёт администратору. Ответ — на ваш профиль или в сообщения.'),
    msg
  ], async () => {
    const text = msg.value.trim();
    if (!text) { toast.warn('Напишите сообщение'); return false; }
    const r = await api.report('support', 'support', text).catch(() => ({ ok: false }));
    if (r.ok) { toast.ok('Сообщение отправлено в поддержку'); return true; }
    toast.err('Не удалось отправить'); return false;
  }, 'Отправить', { guard: true });
}

// Explicit consent modal shown once after first login. Cannot be dismissed without accepting.
function showConsentGate() {
  if (document.getElementById('consent-host')) return;
  const check1 = el('input', { type: 'checkbox', id: 'consent-c1' });
  const check2 = el('input', { type: 'checkbox', id: 'consent-c2' });
  const accept = el('button', { class: 'btn', type: 'button', disabled: true }, 'Принять и продолжить');
  const sync = () => { accept.disabled = !(check1.checked && check2.checked); };
  check1.addEventListener('change', sync);
  check2.addEventListener('change', sync);

  accept.addEventListener('click', async () => {
    accept.disabled = true;
    const r = await api.request('/api/consent', { method: 'POST' }).catch(() => ({ ok: false }));
    if (r.ok) { host.remove(); document.body.style.overflow = ''; toast.ok('Добро пожаловать!'); }
    else { accept.disabled = false; toast.err('Ошибка, попробуйте ещё раз'); }
  });

  const host = el('div', { id: 'consent-host', class: 'modal-host' },
    el('div', { class: 'modal-dialog', style: { maxWidth: '440px' } },
      el('div', { class: 'modal-head' }, el('div', { class: 'modal-title' }, 'Добро пожаловать в SOKOLENOK')),
      el('div', { class: 'modal-body' },
        el('div', { class: 'consent-intro' }, 'Перед началом подтвердите согласие. Это нужно один раз.'),
        el('label', { class: 'consent-row' }, check1,
          el('span', null, 'Мне исполнилось 16 лет, и я принимаю ',
            el('a', { href: '/terms', target: '_blank' }, 'Пользовательское соглашение'), ', ',
            el('a', { href: '/privacy', target: '_blank' }, 'Политику конфиденциальности'), ' и ',
            el('a', { href: '/rules', target: '_blank' }, 'Правила сообщества'), '.')),
        el('label', { class: 'consent-row' }, check2,
          el('span', null, 'Я даю согласие на обработку моих данных (SteamID, публичный профиль, создаваемый мной контент) в целях работы сервиса.'))
      ),
      el('div', { class: 'modal-foot' },
        el('a', { class: 'btn btn-ghost', href: '/auth/logout' }, 'Выйти'),
        accept
      )
    )
  );
  document.body.appendChild(host);
  document.body.style.overflow = 'hidden';
}

// Mobile burger button + overlay to toggle the sidebar on small screens.
// Instagram-style fixed bottom navigation for mobile.
function ensureMobileNav() {
  // Build once; rebuild active state each call.
  let bar = document.getElementById('bottom-nav');
  const buildItems = (me) => ([
    { href: '/dashboard', label: 'Главная',   key: 'dashboard', icon: 'home' },
    { href: '/feed',      label: 'Лента',      key: 'feed',      icon: 'feed' },
    { href: '/messages',  label: 'Чаты',       key: 'messages',  icon: 'mail', badge: true },
    { href: '/inventory', label: 'Инвентарь',  key: 'inventory', icon: 'inventory' },
    { href: '/me',        label: 'Вы',         key: 'me',        icon: 'user' }
  ]);

  // Only for logged-in users
  const meCached = window.__me;
  if (!meCached || !meCached.logged_in) {
    if (bar) bar.remove();
    return;
  }

  const active = document.body.dataset.page;
  if (!bar) {
    bar = el('nav', { id: 'bottom-nav', class: 'bottom-nav' });
    document.body.appendChild(bar);
  }
  bar.innerHTML = '';
  for (const item of buildItems(meCached)) {
    const isActive = active === item.key ||
      (item.key === 'me' && ['settings', 'friends', 'communities'].includes(active));
    const link = el('a', { class: 'bn-item' + (isActive ? ' active' : ''), href: item.href },
      el('span', { class: 'bn-icon', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${navIconPath(item.icon)}</svg>` }),
      el('span', { class: 'bn-label' }, item.label)
    );
    if (item.badge) {
      const badgeId = item.badge === 'notif' ? 'bn-notif' : 'bn-unread';
      const b = el('span', { class: 'bn-badge', id: badgeId, style: { display: 'none' } }, '');
      link.querySelector('.bn-icon').appendChild(b);
    }
    bar.appendChild(link);
  }
  // mark body so we can add bottom padding
  document.body.classList.add('has-bottom-nav');
  refreshUnreadBadge();
}

function navIconPath(key) {
  const icons = navIconMap();
  return icons[key] || '';
}

function navIcon(key) {
  return el('span', { class: 'nav-ico', html:
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${navIconPath(key)}</svg>` });
}

function navIconMap() {
  return {
    home:      '<path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/>',
    info:      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/>',
    grid:      '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    users:     '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    help:      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/>',
    inventory: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    feed:      '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    mail:      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    bell:      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    user:      '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  };
}

function _oldNavIcon_unused(key) {
  const icons = {
    home:      '<path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/>',
    info:      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/>',
    grid:      '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    users:     '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    help:      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/>',
    inventory: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    feed:      '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    mail:      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  };
  const svg = icons[key] || icons.info;
  return el('span', { class: 'nav-ico', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>` });
}

async function refreshUnreadBadge() {
  try {
    // Run both in parallel
    const [convR, notifR] = await Promise.all([
      api.conversations().catch(() => null),
      api.request('/api/notifications/count').catch(() => null)
    ]);
    const nMsgs = convR?.unread_total || 0;
    const nNotif = notifR?.unread || 0;
    if (typeof _lastUnread === 'number' && (nMsgs + nNotif) > _lastUnread) {
      playNotifySound();
    }
    _lastUnread = nMsgs + nNotif;
    // Messages badge
    for (const id of ['nav-unread-badge', 'bn-unread', 'top-msg-badge']) {
      const badge = document.getElementById(id);
      if (!badge) continue;
      if (nMsgs > 0) { badge.textContent = nMsgs > 99 ? '99+' : String(nMsgs); badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }
    // Notifications badge (sidebar + bottom-nav)
    for (const id of ['nav-notif-badge', 'bn-notif', 'top-notif-badge']) {
      const badge = document.getElementById(id);
      if (!badge) continue;
      if (nNotif > 0) { badge.textContent = nNotif > 99 ? '99+' : String(nNotif); badge.style.display = ''; }
      else { badge.style.display = 'none'; }
    }
    // Favicon / tab title with combined total
    updateFaviconBadge(nMsgs + nNotif);
    updateTabTitle(nMsgs + nNotif);
  } catch (_) { /* ignore */ }
}
let _lastUnread = null;

// Update browser tab title with unread count — visible when tab is in background
let _origTitle = null;
function updateTabTitle(n) {
  if (_origTitle == null) _origTitle = document.title.replace(/^\(\d+\)\s|\u200B/g, '');
  document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${_origTitle}` : _origTitle;
}

// Draw a red dot on top of the favicon — visible in browser tabs even when minimized
let _faviconBase = null;
function updateFaviconBadge(n) {
  try {
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (_faviconBase == null) _faviconBase = link.getAttribute('href');
    if (n <= 0) { link.setAttribute('href', _faviconBase); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 64);
      // Red dot bottom-right
      ctx.beginPath();
      ctx.arc(48, 48, 14, 0, Math.PI * 2);
      ctx.fillStyle = '#ff3b30';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
      try {
        link.setAttribute('href', c.toDataURL('image/png'));
      } catch (_) { /* CORS — leave default */ }
    };
    img.src = _faviconBase;
  } catch (_) { /* ignore */ }
}

// Generated notification "tink" using Web Audio API — no audio file needed.
// Note: browsers block autoplay until first user interaction; first ping may be silent.
let _audioCtx = null;
function playNotifySound() {
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _audioCtx = new AC();
    }
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    // Two short sine tones, descending — pleasant "tink" not annoying
    for (const [t, freq] of [[0, 880], [0.08, 660]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, now + t);
      g.gain.linearRampToValueAtTime(0.18, now + t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.18);
      o.connect(g); g.connect(ctx.destination);
      o.start(now + t); o.stop(now + t + 0.2);
    }
  } catch (_) { /* ignore */ }
}

function renderSidebar(active, me) {
  const bar = $('#sidebar');
  if (!bar) return;

  // Marketing nav (logged out only)
  const baseItems = [
    { href: '/',         label: 'Главная',     key: 'index',     icon: 'home' },
    { href: '#about',    label: 'О продукте',  key: 'about',     icon: 'info' },
    { href: '#features', label: 'Возможности', key: 'features',  icon: 'grid' },
    { href: '#security', label: 'Безопасность',key: 'security',  icon: 'shield' },
    { href: '#who',      label: 'Для кого',    key: 'who',       icon: 'users' },
    { href: '#faq',      label: 'FAQ',         key: 'faq',       icon: 'help' }
  ];
  // For logged-in users we split nav: top group + Settings pinned to the bottom
  const authedTop = [
    { href: '/dashboard', label: 'Дашборд',   key: 'dashboard', icon: 'home' },
    { href: `/lookup?steamid=${encId(me.steamid)}`, label: 'Мой профиль', key: 'profile', icon: 'users' },
    { href: '/feed',      label: 'Лента',      key: 'feed',      icon: 'feed' },
    { href: '/notifications', label: 'Уведомления', key: 'notifications', icon: 'bell', badge: 'notif' },
    { href: '/messages',  label: 'Сообщения',  key: 'messages',  icon: 'mail', badge: 'unread' },
    { href: '/friends',   label: 'Друзья',     key: 'friends',   icon: 'users' },
    { href: '/communities', label: 'Сообщества', key: 'communities', icon: 'grid' },
    { href: '/inventory', label: 'Инвентарь', key: 'inventory', icon: 'inventory' },
    { action: 'support',  label: 'Поддержка',  key: 'support',   icon: 'help' }
  ];
  const authedBottom = [
    { href: '/settings',  label: 'Настройки', key: 'settings',  icon: 'settings' }
  ];

  bar.innerHTML = '';

  // Brand
  bar.appendChild(el('div', { class: 'brand' },
    el('a', { href: me.logged_in ? '/dashboard' : '/' },
      el('img', { src: '/assets/logo-full-dark.png', alt: 'SOKOLENOK', class: 'brand-logo' })
    )
  ));

  // Main nav (top)
  const nav = el('nav', { class: 'nav' });
  const topItems = me.logged_in ? authedTop : baseItems;
  for (const item of topItems) {
    const isAction = item.action === 'support';
    const link = el(isAction ? 'button' : 'a', isAction
        ? { type: 'button', class: `nav-link${active === item.key ? ' active' : ''}`, onclick: openSupportModal }
        : { class: `nav-link${active === item.key ? ' active' : ''}`, href: item.href },
      navIcon(item.icon), el('span', { class: 'nav-label' }, item.label));
    if (item.badge === 'unread') {
      link.appendChild(el('span', { class: 'nav-badge', id: 'nav-unread-badge', style: { display: 'none' } }, '0'));
    }
    if (item.badge === 'notif') {
      link.appendChild(el('span', { class: 'nav-badge', id: 'nav-notif-badge', style: { display: 'none' } }, '0'));
    }
    nav.appendChild(link);
  }
  bar.appendChild(nav);
  // Admin link (only for admins)
  if (me.logged_in && me.is_admin) {
    const adminNav = el('nav', { class: 'nav', style: { marginTop: '4px' } });
    adminNav.appendChild(el('a', {
      class: `nav-link${active === 'admin' ? ' active' : ''}`, href: '/admin',
      style: { color: 'var(--yellow)' }
    }, navIcon('shield'), el('span', { class: 'nav-label' }, 'Админка')));
    bar.appendChild(adminNav);
  }
  // Kick off async unread count for the messages badge
  if (me.logged_in) refreshUnreadBadge();

  // ---- Bottom of sidebar ----
  // Logged in: user card with avatar + nickname + SteamID, then Settings, then controls.
  // Logged out: keep the "Безопасно" plate so the marketing landing feels alive.
  if (me.logged_in) {
    const p = me.profile || {};
    const card = el('a', { class: 'side-user', href: '/settings',
      title: 'Перейти в настройки' });

    const avatarWrap = el('div', { class: 'side-user-avatar' });
    if (p.avatarfull || p.avatar) {
      const img = el('img', {
        src: p.avatarfull || p.avatar, alt: '', loading: 'lazy'
      });
      img.onerror = function() {
        this.remove();
        avatarWrap.textContent = (p.personaname || '?').slice(0, 1).toUpperCase();
      };
      avatarWrap.appendChild(img);
    } else {
      avatarWrap.textContent = (p.personaname || '?').slice(0, 1).toUpperCase();
    }

    card.appendChild(avatarWrap);
    card.appendChild(el('div', { class: 'side-user-text' },
      el('div', { class: 'side-user-name' }, p.personaname || 'Игрок'),
      el('div', { class: 'side-user-sub' }, me.steamid ? me.steamid.slice(-8) : '')
    ));
    // Pulsing green "live" dot — indicates tracking is on
    card.appendChild(el('span', { class: 'side-user-dot', title: 'Данные актуальны' }));
    bar.appendChild(card);

    // Bottom nav (Settings + future links)
    const navBottom = el('nav', { class: 'nav nav-bottom' });
    for (const item of authedBottom) {
      navBottom.appendChild(el('a', {
        class: `nav-link${active === item.key ? ' active' : ''}`,
        href: item.href
      }, navIcon(item.icon), item.label));
    }
    bar.appendChild(navBottom);
  } else {
    // Logged-out: status plate
    bar.appendChild(el('div', { class: 'side-status' },
      el('div', { class: 'ico', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
      }),
      el('div', { class: 'text' },
        el('div', { class: 't1' }, 'Безопасно.'),
        el('div', { class: 't2' }, 'Только чтение. Никаких изменений в аккаунте.')
      )
    ));
  }

  // Copyright + legal links (always at very bottom)
  bar.appendChild(el('div', { class: 'side-copy' },
    el('div', { class: 'side-legal-links' },
      el('a', { href: '/privacy' }, 'Конфиденциальность'),
      el('a', { href: '/terms' }, 'Соглашение'),
      el('a', { href: '/rules' }, 'Правила')
    ),
    '© 2026 SOKOLENOK.PRO'));

  // Controls (lang) at the very bottom
  bar.appendChild(el('div', { class: 'side-controls' },
    el('button', { class: 'lang-pick', type: 'button',
      onclick: (e) => { e.preventDefault(); toast.ok('Только RU в MVP'); } },
      'RU',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' })
    )
  ));
}

function renderMainToolbar(me) {
  // GPT design system: matches/inventory pages have `.main-top`; landing has no toolbar
  const bar = $('.main-top');
  if (!bar) return;
  bar.innerHTML = '';

  // Status pill (pulsing green dot)
  bar.appendChild(el('div', { class: 'status-pill' },
    el('span', { class: 'dot' }),
    me.logged_in ? 'Трекинг активен' : 'Сервис онлайн'
  ));

  // Login / logout
  if (!me.logged_in) {
    bar.appendChild(el('a', { href: '/auth/steam', class: 'btn btn-primary btn-sm', onclick: steamLogin }, 'Войти через Steam'));
  } else {
    bar.appendChild(el('form', { action: '/auth/logout', method: 'POST', style: { margin: 0 } },
      el('button', { type: 'submit', class: 'btn btn-ghost btn-sm' }, 'Выйти')
    ));
  }
}

function renderSocialTopbar(me) {
  const bar = $('.main-top');
  if (!bar) return;
  bar.innerHTML = '';
  bar.classList.add('social-topbar');

  const search = el('form', { class: 'top-search', role: 'search' },
    el('span', { class: 'top-search-ico', html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' }),
    el('input', { class: 'top-search-input', type: 'search', autocomplete: 'off', placeholder: 'Найти игрока' }),
    el('div', { class: 'top-search-results', hidden: 'hidden' })
  );
  const searchInput = search.querySelector('.top-search-input');
  const searchResults = search.querySelector('.top-search-results');
  const hideSearchResults = () => { searchResults.hidden = true; searchResults.innerHTML = ''; };
  const openUserResult = (sid) => { if (sid) location.assign(`/lookup?steamid=${encId(sid)}`); };
  const drawSearchResults = (users, q) => {
    searchResults.innerHTML = '';
    if (!q || q.length < 2) { hideSearchResults(); return; }
    if (!users.length) {
      searchResults.appendChild(el('div', { class: 'top-search-empty' }, 'Ничего не найдено'));
      searchResults.hidden = false;
      return;
    }
    for (const u of users.slice(0, 6)) {
      const sid = u.steam_id || u.steamid;
      const row = el('button', { class: 'top-search-row', type: 'button',
        onclick: () => openUserResult(sid) });
      const ava = el('span', { class: 'top-search-ava' });
      if (u.avatar) {
        const img = el('img', { src: u.avatar, alt: '' });
        img.onerror = function() { this.remove(); ava.textContent = (u.persona_name || u.name || '?').slice(0, 1).toUpperCase(); };
        ava.appendChild(img);
      } else ava.textContent = (u.persona_name || u.name || '?').slice(0, 1).toUpperCase();
      row.appendChild(ava);
      row.appendChild(el('span', { class: 'top-search-meta' },
        el('strong', null, u.persona_name || u.name || sid),
        el('small', null, /^tg:\d+$/.test(String(sid || '')) ? 'Telegram' : String(sid || '').slice(-8))
      ));
      searchResults.appendChild(row);
    }
    searchResults.hidden = false;
  };
  const liveSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (q.length < 2) { hideSearchResults(); return; }
    const r = await api.request(`/api/search?kind=users&q=${encodeURIComponent(q)}`).catch(() => null);
    drawSearchResults(r?.users || [], q);
  }, 220);
  searchInput.addEventListener('input', liveSearch);
  searchInput.addEventListener('focus', () => { if (searchResults.children.length) searchResults.hidden = false; });
  search.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    const direct = await api.resolveAny(q).catch(() => null);
    if (direct) { location.assign(`/lookup?steamid=${encId(direct)}`); return; }
    const found = await api.request(`/api/search?kind=users&q=${encodeURIComponent(q)}`).catch(() => null);
    const user = found?.users?.[0];
    if (user?.steam_id) location.assign(`/lookup?steamid=${encId(user.steam_id)}`);
    else toast.warn('Игрок не найден');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.top-search')) hideSearchResults();
  });
  bar.appendChild(search);

  const actions = el('div', { class: 'top-actions' });
  if (!me.logged_in) {
    actions.appendChild(el('a', { href: '/auth/steam', class: 'btn btn-primary btn-sm', onclick: steamLogin }, 'Войти'));
  } else {
    actions.appendChild(el('div', { class: 'top-notif-wrap' },
      el('button', { class: 'icon-btn top-icon-btn', type: 'button', id: 'top-notif-btn', title: 'Уведомления',
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="top-badge" id="top-notif-badge" style="display:none">0</span>' }),
      el('div', { class: 'notif-popover', id: 'notif-popover', hidden: 'hidden' })
    ));
    actions.appendChild(el('a', { class: 'icon-btn top-icon-btn', href: '/messages', title: 'Сообщения',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><span class="top-badge" id="top-msg-badge" style="display:none">0</span>' }));
    const p = me.profile || {};
    actions.appendChild(el('a', { class: 'top-avatar', href: `/lookup?steamid=${encId(me.steamid)}`, title: 'Мой профиль' },
      (p.avatar || p.avatarfull)
        ? el('img', { src: p.avatar || p.avatarfull, alt: '' })
        : el('span', null, (p.personaname || '?').slice(0, 1).toUpperCase())
    ));
    queueMicrotask(wireNotificationPopover);
  }
  bar.appendChild(actions);
}

function wireNotificationPopover() {
  const btn = $('#top-notif-btn');
  const pop = $('#notif-popover');
  if (!btn || !pop || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  const close = () => { pop.hidden = true; };
  const open = async () => {
    pop.hidden = false;
    pop.innerHTML = '<div class="notif-popover-loading"><div class="spinner sm"></div>Загрузка...</div>';
    const r = await api.request('/api/notifications').catch(() => null);
    pop.innerHTML = '';
    pop.appendChild(el('div', { class: 'notif-popover-head' },
      el('strong', null, 'Уведомления'),
      el('a', { href: '/notifications' }, 'Все')
    ));
    const items = (r?.notifications || []).slice(0, 6);
    if (!items.length) pop.appendChild(el('div', { class: 'notif-popover-empty' }, 'Пока тихо'));
    else for (const n of items) pop.appendChild(buildNotificationRow(n, true));
    refreshUnreadBadge();
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop.hidden) open();
    else close();
  });
  document.addEventListener('click', (e) => {
    if (!pop.hidden && !e.target.closest('.top-notif-wrap')) close();
  });
}

// ============ profile card ============
function renderProfileCard(profile, opts = {}) {
  const visibilityState = Number(profile?.communityvisibilitystate || 0);
  const vis = visibilityState === 3 ? { class: 'public', label: 'Публичный' }
    : visibilityState === 2 ? { class: 'friends', label: 'Только друзья' }
    : { class: 'private', label: 'Закрытый' };
  const avatarUrl = profile?.avatarfull || profile?.avatar || '';
  const avatarNode = avatarUrl
    ? el('img', { class: 'avatar', src: avatarUrl, alt: profile?.personaname || '' })
    : el('div', { class: 'avatar avatar-empty' }, '👤');
  const sub = el('div', { class: 'profile-sub' });
  if (profile?.steamid) {
    sub.appendChild(el('span', { class: 'id-chip' }, profile.steamid));
  }
  sub.appendChild(el('span', { class: `visibility-chip ${vis.class}` }, vis.label));
  if (profile?.country) sub.appendChild(el('span', null, profile.country));
  if (profile?.profileurl) sub.appendChild(el('a', { href: profile.profileurl, target: '_blank', rel: 'noopener' }, 'Открыть в Steam ↗'));
  if (profile?.fetched_at) sub.appendChild(el('span', { class: 'text-mute text-xs' }, `обновлено ${relativeTime(profile.fetched_at)}`));

  return el('div', { class: 'card' },
    el('div', { class: 'profile-card' },
      avatarNode,
      el('div', { class: 'profile-meta' },
        el('div', { class: 'profile-name' }, profile?.personaname || 'Без имени'),
        sub
      )
    )
  );
}

// ============ inventory rendering helpers ============
function buildInventoryKpis(inventoryResp) {
  const total = inventoryResp.total_items || 0;
  const value = inventoryResp.total_value;
  const currency = inventoryResp.currency || 'RUB';
  const priced = inventoryResp.pricing?.priced_items || 0;
  const unpriced = inventoryResp.pricing?.unpriced_items || 0;
  const top = (inventoryResp.items || [])
    .filter(i => i.price_value != null)
    .sort((a, b) => b.price_value - a.price_value)[0];

  return el('div', { class: 'kpis' },
    el('div', { class: 'kpi accent' },
      el('div', { class: 'kpi-label' }, 'Общая стоимость'),
      el('div', { class: 'kpi-value' }, value != null ? fmtPrice(value, currency) : '—'),
      el('div', { class: 'kpi-sub' }, `${priced} c ценой · ${unpriced} без цены`)
    ),
    el('div', { class: 'kpi' },
      el('div', { class: 'kpi-label' }, 'Предметов'),
      el('div', { class: 'kpi-value' }, fmtNumber(total)),
      el('div', { class: 'kpi-sub' }, `${inventoryResp.pricing?.unique_names || 0} уникальных`)
    ),
    el('div', { class: 'kpi' },
      el('div', { class: 'kpi-label' }, 'Самый дорогой'),
      el('div', { class: 'kpi-value', style: { fontSize: '15px', lineHeight: '1.3' } },
        top ? top.market_name.slice(0, 32) + (top.market_name.length > 32 ? '…' : '') : '—'),
      el('div', { class: 'kpi-sub' }, top ? fmtPrice(top.price_value, currency) : '')
    ),
    el('div', { class: 'kpi' },
      el('div', { class: 'kpi-label' }, 'Валюта'),
      el('div', { class: 'kpi-value' }, currency),
      el('div', { class: 'kpi-sub' }, 'Steam Market')
    )
  );
}

function inventoryStatusMessage(status, httpStatus) {
  const map = {
    'private': { kind: 'warn', title: 'Инвентарь закрыт', desc: 'Этот аккаунт сделал инвентарь приватным. Открой его в настройках приватности Steam → CS2 inventory.' },
    'rate-limited': { kind: 'warn', title: 'Steam ограничил запросы', desc: 'Steam временно отдаёт rate-limit. Подожди пару минут и обнови.' },
    'steam-error': { kind: 'error', title: 'Steam сейчас недоступен', desc: 'Сервис Steam отвечает ошибкой. Попробуй позже.' },
    'network-error': { kind: 'error', title: 'Не дотянулись до Steam', desc: 'Сетевая ошибка при запросе инвентаря.' },
    'parse-error': { kind: 'error', title: 'Steam отдал что-то странное', desc: 'Ответ не распарсился. Возможно, временный сбой Steam.' },
    'not-found': { kind: 'warn', title: 'Профиль не найден', desc: 'Steam не нашёл этот SteamID.' },
    'empty': { kind: 'info', title: 'Инвентарь пуст', desc: 'У этого игрока в CS2 нет предметов или они скрыты.' },
    'unknown-error': { kind: 'error', title: 'Неизвестная ошибка', desc: 'Что-то пошло не так. См. /api/health.' }
  };
  const m = map[status] || map['unknown-error'];
  return el('div', { class: `alert alert-${m.kind === 'error' ? 'error' : m.kind === 'warn' ? 'warn' : 'info'}` },
    el('div', null,
      el('strong', null, m.title),
      el('div', { class: 'text-sm mt-1' }, m.desc + (httpStatus ? ` (HTTP ${httpStatus})` : ''))
    )
  );
}

// ============ page: index (landing) ============
async function pageIndex() {
  await renderTopbar();
  const me = await api.me().catch(() => ({ logged_in: false }));
  if (me.logged_in) {
    // Already logged in — go straight to dashboard
    location.replace('/dashboard');
    return;
  }

  const lookupForm = $('#lookupForm');
  if (lookupForm) {
    lookupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#lookupInput').value.trim();
      if (!input) { toast.warn('Введите SteamID или ссылку'); return; }
      const submitBtn = lookupForm.querySelector('button[type="submit"]');
      const origText = submitBtn.textContent;
      submitBtn.disabled = true; submitBtn.textContent = 'Ищем…';
      try {
        track('lookup_started', { target: input.slice(0, 80) });
        const r = await api.resolve(input);
        if (r.ok) location.assign(`/lookup?steamid=${encId(r.steamid)}`);
        else toast.err('Не нашли такого игрока в Steam');
      } catch (e) {
        toast.err('Не удалось разрешить');
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = origText;
      }
    });
  }

  // Show auth=failed banner if redirected here from failed login
  const params = new URLSearchParams(location.search);
  const authErr = params.get('auth');
  if (authErr) {
    const msgMap = {
      'failed': 'Steam не подтвердил OpenID. Попробуй ещё раз.',
      'invalid': 'Steam отверг подпись. Попробуй ещё раз.',
      'tg-not-configured': 'Telegram-вход временно недоступен.',
      'tg-bad-callback': 'Telegram прислал некорректные данные. Попробуй ещё раз.',
      'tg-bad-signature': 'Не удалось проверить подпись Telegram. Попробуй ещё раз.',
      'tg-stale': 'Истёк срок действия ссылки от Telegram. Войди заново.'
    };
    const msg = msgMap[authErr] || 'Не удалось войти. Попробуй ещё раз.';
    const banner = el('div', { class: 'alert alert-error' },
      el('div', null,
        el('strong', null, 'Вход не удался'),
        el('div', { class: 'text-sm mt-1' }, msg)
      ));
    const target = $('.hero');
    if (target) target.parentNode.insertBefore(banner, target);
  }

  // Telegram login button — mounted next to the Steam login on the landing.
  // The widget is loaded lazily because it pulls a script from telegram.org;
  // we don't want to slow down the page when the user has no intent to log in.
  mountTelegramLoginButton();

  // Live feed preview — shows guests there's actually activity in the community.
  // Loads top 6 recent items from /api/feed?scope=all (works without auth).
  // If feed is empty (fresh install / network issue), the section hides itself.
  mountRecentFeedPreview();
}

async function mountRecentFeedPreview() {
  const root = document.getElementById('recent-feed-list');
  const section = document.getElementById('recent-feed');
  if (!root || !section) return;
  try {
    const r = await fetch('/api/feed?scope=all').then(r => r.json());
    const items = (r?.items || []).filter(i => i.kind === 'post').slice(0, 6);
    if (!items.length) {
      section.style.display = 'none';
      return;
    }
    root.innerHTML = '';
    for (const it of items) {
      const card = el('a', { class: 'lp-feed-card', href: '/feed' });
      // Header: public name + date
      card.appendChild(el('div', { class: 'lp-feed-card-h' },
        el('div', { class: 'lp-feed-pub-avatar' + (it.public_id === 'official' ? ' official' : '') },
          it.public_avatar
            ? el('img', { src: it.public_avatar, alt: '' })
            : (it.public_name || '?').slice(0, 1).toUpperCase()
        ),
        el('div', { class: 'lp-feed-pub-meta' },
          el('div', { class: 'lp-feed-pub-name' }, it.public_name || ''),
          el('div', { class: 'lp-feed-pub-date' }, it.created_at ? relDate(it.created_at) : '')
        )
      ));
      if (it.title) card.appendChild(el('div', { class: 'lp-feed-card-title' }, it.title));
      if (it.image) card.appendChild(el('img', { class: 'lp-feed-card-img', src: it.image, alt: '', loading: 'lazy' }));
      if (it.body) {
        const txt = String(it.body).replace(/<[^>]+>/g, '').slice(0, 180);
        card.appendChild(el('div', { class: 'lp-feed-card-body' }, txt + (it.body.length > 180 ? '…' : '')));
      }
      const stats = el('div', { class: 'lp-feed-card-stats' });
      if (it.likes != null) stats.appendChild(el('span', null, `❤ ${it.likes}`));
      if (it.comments != null) stats.appendChild(el('span', null, `💬 ${it.comments}`));
      if (stats.children.length) card.appendChild(stats);
      root.appendChild(card);
    }
  } catch (_) {
    section.style.display = 'none';
  }
}

// Inserts the Telegram Login Widget into a container with id #tg-login-mount
// on the landing page. The widget renders Telegram's own blue button; on
// success it redirects to /auth/telegram/callback?... with the signed payload.
async function mountTelegramLoginButton() {
  const mount = document.getElementById('tg-login-mount');
  if (!mount) return;
  // Show a placeholder button immediately so the user sees "Войти через Telegram"
  // before telegram.org's widget script loads (usually 0.5-1.5s). When the real
  // widget renders its iframe, the placeholder is hidden by CSS (it has a sibling).
  mount.appendChild(el('div', { class: 'tg-login-placeholder' },
    el('span', {
      class: 'tg-login-placeholder-icon',
      html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>'
    }),
    el('span', null, 'Войти через Telegram')
  ));
  try {
    const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => null);
    if (!cfg?.ok || !cfg.telegram || !cfg.telegram_bot) {
      mount.remove();
      return;
    }
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', cfg.telegram_bot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '8');
    s.setAttribute('data-auth-url', `${location.origin}/auth/telegram/callback`);
    s.setAttribute('data-request-access', 'write');
    mount.appendChild(s);
  } catch (_) {
    mount.remove();
  }
}

// ============ page: dashboard ============
// ============ shared formatters / helpers ============
function fmtPct(n, frac = 1, withSign = false) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const s = withSign ? (v > 0 ? '+' : '') : '';
  return `${s}${v.toFixed(frac)}%`;
}

// Map cosmetic info — display name + PNG icon URL. Gradient kept as fallback bg
// while the image loads. Icons live in /assets/maps/{key}.png.
const MAP_LOOKS = {
  mirage:      { name: 'Mirage',   image: '/assets/maps/mirage.png',      grad: 'linear-gradient(135deg,#b8763e,#5d3a1c)' },
  inferno:     { name: 'Inferno',  image: '/assets/maps/inferno.png',     grad: 'linear-gradient(135deg,#9a3a2a,#5a1f12)' },
  // Anubis icon was missing from the provided set — use a generated gradient placeholder
  anubis:      { name: 'Anubis',   image: null,                            grad: 'linear-gradient(135deg,#3d6a8a,#1d3b54)' },
  overpass:    { name: 'Overpass', image: '/assets/maps/overpass.png',    grad: 'linear-gradient(135deg,#7a4a2a,#3a1f12)' },
  nuke:        { name: 'Nuke',     image: '/assets/maps/nuke.png',        grad: 'linear-gradient(135deg,#5a5a5a,#2a2a2a)' },
  ancient:     { name: 'Ancient',  image: '/assets/maps/ancient.png',     grad: 'linear-gradient(135deg,#3a7a4a,#1a4a2a)' },
  dust2:       { name: 'Dust II',  image: '/assets/maps/dust2.png',       grad: 'linear-gradient(135deg,#c4a13b,#6a5a16)' },
  vertigo:     { name: 'Vertigo',  image: '/assets/maps/vertigo.png',     grad: 'linear-gradient(135deg,#7a7a8a,#3a3a4a)' },
  train:       { name: 'Train',    image: '/assets/maps/train.png',       grad: 'linear-gradient(135deg,#6a4a3a,#3a2a1a)' },
  cache:       { name: 'Cache',    image: '/assets/maps/cache.png',       grad: 'linear-gradient(135deg,#8a6a3a,#4a3a1a)' },
  cobblestone: { name: 'Cobble',   image: '/assets/maps/cobblestone.png', grad: 'linear-gradient(135deg,#6a6a6a,#3a3a3a)' },
  italy:       { name: 'Italy',    image: '/assets/maps/italy.png',       grad: 'linear-gradient(135deg,#9a3a3a,#5a1f1f)' },
  office:      { name: 'Office',   image: '/assets/maps/office.png',      grad: 'linear-gradient(135deg,#5a5a8a,#2a2a4a)' },
  assault:     { name: 'Assault',  image: '/assets/maps/assault.png',     grad: 'linear-gradient(135deg,#6a6a6a,#3a3a3a)' },
  lake:        { name: 'Lake',     image: '/assets/maps/lake.png',        grad: 'linear-gradient(135deg,#3a6a8a,#1a3a4a)' },
  militia:     { name: 'Militia',  image: '/assets/maps/militia.png',     grad: 'linear-gradient(135deg,#4a6a3a,#2a4a1a)' },
  shortdust:   { name: 'Shortdust',image: '/assets/maps/shortdust.png',   grad: 'linear-gradient(135deg,#c4a13b,#6a5a16)' }
};
function lookMap(key) {
  const k = String(key || '').toLowerCase().replace(/^(de|cs)_/, '');
  return MAP_LOOKS[k] || { name: key || 'Unknown', image: null, grad: 'linear-gradient(135deg,#444,#222)' };
}

// Build a map-icon element (img tag if we have the asset, gradient + first-letter otherwise)
function mapIconEl(look) {
  const wrap = el('div', { class: 'map-ico', style: { background: look.grad } });
  if (look.image) {
    const img = el('img', { src: look.image, alt: '', loading: 'lazy',
      style: { opacity: '0', transition: 'opacity 0.3s ease' } });
    img.onload = function() { this.style.opacity = '1'; };
    img.onerror = function() { this.remove(); wrap.appendChild(letterFallback(look.name)); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(letterFallback(look.name));
  }
  return wrap;
}
function letterFallback(name) {
  return el('span', { class: 'ico-letter' }, String(name || '?').slice(0, 1).toUpperCase());
}

// Weapon cosmetic info — same pattern, icons in /assets/weapons/weapon_{key}.png
const WEAPON_LOOKS = {
  ak47:    { name: 'AK-47',    image: '/assets/weapons/weapon_ak47.png' },
  m4a1:    { name: 'M4A1-S',   image: '/assets/weapons/weapon_m4a1_silencer.png' },
  m4a4:    { name: 'M4A4',     image: '/assets/weapons/weapon_m4a1.png' },
  awp:     { name: 'AWP',      image: '/assets/weapons/weapon_awp.png' },
  ssg08:   { name: 'SSG 08',   image: '/assets/weapons/weapon_ssg08.png' },
  scar20:  { name: 'SCAR-20',  image: '/assets/weapons/weapon_scar20.png' },
  g3sg1:   { name: 'G3SG1',    image: '/assets/weapons/weapon_g3sg1.png' },
  deagle:  { name: 'Desert Eagle', image: '/assets/weapons/weapon_deagle.png' },
  glock:   { name: 'Glock-18', image: '/assets/weapons/weapon_glock.png' },
  usp:     { name: 'USP-S',    image: '/assets/weapons/weapon_usp_silencer.png' },
  hkp2000: { name: 'P2000',    image: '/assets/weapons/weapon_hkp2000.png' },
  p250:    { name: 'P250',     image: '/assets/weapons/weapon_p250.png' },
  fiveseven:{ name: 'Five-SeveN', image: '/assets/weapons/weapon_fiveseven.png' },
  tec9:    { name: 'Tec-9',    image: '/assets/weapons/weapon_tec9.png' },
  cz75a:   { name: 'CZ75-Auto', image: '/assets/weapons/weapon_cz75a.png' },
  elite:   { name: 'Dual Berettas', image: '/assets/weapons/weapon_elite.png' },
  revolver:{ name: 'R8 Revolver', image: '/assets/weapons/weapon_revolver.png' },
  mp9:     { name: 'MP9',      image: '/assets/weapons/weapon_mp9.png' },
  mp7:     { name: 'MP7',      image: '/assets/weapons/weapon_mp7.png' },
  mac10:   { name: 'MAC-10',   image: '/assets/weapons/weapon_mac10.png' },
  ump45:   { name: 'UMP-45',   image: '/assets/weapons/weapon_ump45.png' },
  p90:     { name: 'P90',      image: '/assets/weapons/weapon_p90.png' },
  bizon:   { name: 'PP-Bizon', image: '/assets/weapons/weapon_bizon.png' },
  mp5sd:   { name: 'MP5-SD',   image: null }, // not in provided set
  famas:   { name: 'FAMAS',    image: '/assets/weapons/weapon_famas.png' },
  galilar: { name: 'Galil AR', image: '/assets/weapons/weapon_galilar.png' },
  aug:     { name: 'AUG',      image: '/assets/weapons/weapon_aug.png' },
  sg556:   { name: 'SG 553',   image: '/assets/weapons/weapon_sg556.png' },
  nova:    { name: 'Nova',     image: '/assets/weapons/weapon_nova.png' },
  mag7:    { name: 'MAG-7',    image: '/assets/weapons/weapon_mag7.png' },
  xm1014:  { name: 'XM1014',   image: '/assets/weapons/weapon_xm1014.png' },
  sawedoff:{ name: 'Sawed-Off', image: '/assets/weapons/weapon_sawedoff.png' },
  m249:    { name: 'M249',     image: '/assets/weapons/weapon_m249.png' },
  negev:   { name: 'Negev',    image: '/assets/weapons/weapon_negev.png' },
  knife:   { name: 'Нож',      image: '/assets/weapons/weapon_knife.png' },
  taser:   { name: 'Zeus x27', image: '/assets/weapons/weapon_taser.png' },
  c4:      { name: 'C4',       image: '/assets/weapons/weapon_c4.png' },
  hegrenade:    { name: 'HE-граната',    image: '/assets/weapons/weapon_hegrenade.png' },
  flashbang:    { name: 'Flashbang',     image: '/assets/weapons/weapon_flashbang.png' },
  smokegrenade: { name: 'Дымовая',       image: '/assets/weapons/weapon_smokegrenade.png' },
  molotov:      { name: 'Molotov',       image: '/assets/weapons/weapon_molotov.png' },
  incgrenade:   { name: 'Incendiary',    image: '/assets/weapons/weapon_incgrenade.png' },
  decoy:        { name: 'Decoy',         image: '/assets/weapons/weapon_decoy.png' }
};
function lookWeapon(key) {
  const k = String(key || '').toLowerCase();
  return WEAPON_LOOKS[k] || { name: key || 'Unknown', image: null };
}

function weaponIconEl(look) {
  const wrap = el('div', { class: 'w-ico' });
  if (look.image) {
    const img = el('img', { src: look.image, alt: '', loading: 'lazy',
      style: { opacity: '0', transition: 'opacity 0.3s ease' } });
    img.onload = function() { this.style.opacity = '1'; };
    img.onerror = function() { this.remove(); wrap.appendChild(letterFallback(look.name)); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(letterFallback(look.name));
  }
  return wrap;
}

function emptyCard(title, message, icon = '📊', action = null) {
  const actions = Array.isArray(action) ? action.filter(Boolean) : (action ? [action] : []);
  return el('div', { class: 'card' },
    el('div', { class: 'card-h' }, el('h2', null, title)),
    el('div', { class: 'empty-state' },
      el('div', { class: 'icon' }, icon),
      el('div', { class: 'title' }, title || 'Пока нет данных'),
      el('div', { class: 'desc' }, message),
      actions.length ? el('div', { class: 'empty-state-actions' },
        actions.map(a => a.href
          ? el('a', { class: a.class || 'btn btn-sm', href: a.href, onclick: a.onclick || null }, a.label)
          : el('button', { class: a.class || 'btn btn-sm', type: 'button', onclick: a.onclick }, a.label))
      ) : null
    )
  );
}

function renderFirstVisitActions(me) {
  const main = document.querySelector('.dash-main');
  if (!main || document.getElementById('first-visit-actions')) return;
  const profileHref = `/lookup?steamid=${encId(me.steamid)}`;
  const card = el('div', { class: 'card first-visit-actions', id: 'first-visit-actions' },
    el('div', { class: 'first-visit-head' },
      el('div', null,
        el('div', { class: 'card-eyebrow' }, 'С чего начать'),
        el('h2', null, 'Три быстрых действия')
      ),
      el('div', { class: 'first-visit-note' }, 'Для первого визита')
    ),
    el('div', { class: 'first-visit-grid' },
      el('button', { class: 'first-visit-item primary', type: 'button', onclick: openSearchModal },
        el('span', { class: 'first-visit-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' }),
        el('span', { class: 'first-visit-copy' },
          el('strong', null, 'Проверить игрока'),
          el('small', null, 'Ник, ссылка Steam или SteamID')
        )
      ),
      el('a', { class: 'first-visit-item', href: profileHref },
        el('span', { class: 'first-visit-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' }),
        el('span', { class: 'first-visit-copy' },
          el('strong', null, 'Открыть свой профиль'),
          el('small', null, 'Так вас видят другие')
        )
      ),
      el('a', { class: 'first-visit-item', href: '/friends' },
        el('span', { class: 'first-visit-icon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' }),
        el('span', { class: 'first-visit-copy' },
          el('strong', null, 'Найти друзей'),
          el('small', null, 'Добавить знакомых на сайте')
        )
      )
    )
  );
  main.insertBefore(card, main.firstElementChild);
}

function digestItem(icon, title, text, href) {
  const content = [
    el('div', { class: 'daily-ico' }, icon),
    el('div', { class: 'daily-copy' },
      el('div', { class: 'daily-item-title' }, title),
      el('div', { class: 'daily-item-text' }, text)
    )
  ];
  return href
    ? el('a', { class: 'daily-item', href }, content)
    : el('div', { class: 'daily-item' }, content);
}

function inventoryDeltaText(history) {
  const snaps = Array.isArray(history?.snapshots) ? history.snapshots : [];
  if (snaps.length < 2) return null;
  const latest = snaps[0], prev = snaps.find(s => s && s.total_value != null && s.id !== latest.id);
  if (!latest || latest.total_value == null || !prev || prev.total_value == null) return null;
  const delta = Number(latest.total_value) - Number(prev.total_value);
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return null;
  const sign = delta > 0 ? '+' : '';
  const currency = latest.currency || prev.currency || 'RUB';
  return `${sign}${fmtPrice(delta, currency)} с прошлого снимка`;
}

async function mountDailyDigest(me) {
  const main = document.querySelector('.dash-main');
  if (!main || document.getElementById('daily-digest')) return;

  const card = el('div', { class: 'card daily-digest', id: 'daily-digest' },
    el('div', { class: 'daily-head' },
      el('div', null,
        el('div', { class: 'card-eyebrow' }, 'Сегодня'),
        el('h2', null, 'Что изменилось')
      ),
      el('a', { class: 'daily-profile', href: `/lookup?steamid=${encId(me.steamid)}` }, 'Мой профиль')
    ),
    el('div', { class: 'daily-grid' },
      digestItem('•', 'Собираем сводку', 'Проверяем сообщения, друзей и профиль.', null)
    )
  );
  main.insertBefore(card, main.firstElementChild);

  const [notif, convos, friends, hist, rep] = await Promise.all([
    api.request('/api/notifications/count').catch(() => null),
    api.conversations().catch(() => null),
    api.friends().catch(() => null),
    isSteamId(me.steamid) ? api.inventoryHistory(me.steamid).catch(() => null) : Promise.resolve(null),
    api.reputation.get(me.steamid).catch(() => null)
  ]);

  const items = [];
  const unreadNotifs = Number(notif?.unread || 0);
  const unreadMsgs = Number(convos?.unread_total || 0);
  const incoming = (friends?.incoming || []).length;
  const friendCount = (friends?.friends || []).length;
  const outgoing = (friends?.outgoing || []).length;
  const delta = inventoryDeltaText(hist);
  const repTotal = Number(rep?.total || 0);

  if (unreadMsgs > 0) {
    items.push(digestItem('✉', 'Новые сообщения', `${unreadMsgs} ${plural(unreadMsgs, ['непрочитанное', 'непрочитанных', 'непрочитанных'])}`, '/messages'));
  }
  if (incoming > 0) {
    items.push(digestItem('+', 'Заявки в друзья', `${incoming} ${plural(incoming, ['заявка ждёт', 'заявки ждут', 'заявок ждут'])} ответа`, '/friends'));
  }
  if (unreadNotifs > 0) {
    items.push(digestItem('🔔', 'Есть события', `${unreadNotifs} ${plural(unreadNotifs, ['новое уведомление', 'новых уведомления', 'новых уведомлений'])}`, '/notifications'));
  }
  if (delta) {
    items.push(digestItem('₽', 'Инвентарь двинулся', delta, '/inventory'));
  }
  if (rep?.ok && repTotal > 0) {
    items.push(digestItem('★', 'Репутация', `+${rep.praise || 0} / -${rep.reports || 0}, ${repTotal} ${plural(repTotal, ['оценка', 'оценки', 'оценок'])}`, `/lookup?steamid=${encId(me.steamid)}#lk-reputation`));
  }
  if (!items.length) {
    const friendLine = friendCount > 0
      ? `${friendCount} ${plural(friendCount, ['друг', 'друга', 'друзей'])} на сайте`
      : 'друзей пока нет';
    items.push(digestItem('✓', 'Спокойный день', `Новых событий нет, ${friendLine}.`, '/friends'));
    if (outgoing > 0) items.push(digestItem('→', 'Заявки отправлены', `${outgoing} ${plural(outgoing, ['ожидает', 'ожидают', 'ожидают'])} ответа`, '/friends'));
  }

  const grid = card.querySelector('.daily-grid');
  grid.innerHTML = '';
  for (const item of items.slice(0, 4)) grid.appendChild(item);
}

// ============ page: dashboard ============
async function pageDashboard() {
  const me = await renderTopbar('dashboard');
  if (!me.logged_in) {
    toast.warn('Войдите через Steam, чтобы открыть дашборд');
    setTimeout(() => location.replace('/'), 800);
    return;
  }

  // Personalize title with profile name
  const titleEl = $('#dash-title');
  const subEl = $('#dash-sub');
  if (titleEl && me.profile?.personaname) {
    titleEl.textContent = `${me.profile.personaname} · матчи и аналитика`;
  }
  // "Open my public profile" — compact icon-only button next to the title.
  // The dashboard is for analytics; this is a quiet way to switch to the
  // social-profile view without consuming visual weight.
  if (titleEl && !document.getElementById('dash-view-profile')) {
    const btn = el('a', {
      id: 'dash-view-profile',
      href: `/lookup?steamid=${encId(me.steamid)}`,
      class: 'dash-profile-link',
      title: 'Открыть мою публичную страницу',
      'aria-label': 'Открыть мою публичную страницу',
      html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
    });
    titleEl.appendChild(btn);
  }
  // Clear any leftover data-attr from old mode logic (no-op if absent)
  delete document.body.dataset.dashMode;
  renderFirstVisitActions(me);
  mountDailyDigest(me);

  // Load Steam stats first — these block the main UI (KPI row + Steam tables)
  let statsResp;
  try {
    statsResp = await api.stats(me.steamid);
  } catch (_) {
    statsResp = { ok: false, reason: 'network', items: [], summary: null };
  }
  paintDashKpis(statsResp);
  paintDashRow1(statsResp);
  paintDashRow2(statsResp);

  // Wire up rail lookup form + recent history
  wireDashLookup();

  // Faceit non-blocking
  const fcNick = (me.settings?.faceit_nickname || '').trim();
  api.faceit(me.steamid, { matches: 10, nickname: fcNick || undefined })
    .then(r => {
      paintDashFaceit(r);
      paintDashMatches(r);
      paintDashTeammates(r);
    })
    .catch(() => {
      paintDashFaceit({ ok: false, reason: 'network' });
      paintDashMatches({ ok: false, reason: 'network' });
      paintDashTeammates({ ok: false, reason: 'network' });
    });

  // News non-blocking
  api.news(6)
    .then(r => paintDashNews(r))
    .catch(() => paintDashNews({ ok: false, items: [] }));
}

function statsUnavailableReason(statsResp) {
  if (!statsResp || statsResp.ok === false) {
    const r = statsResp?.reason || '';
    if (r === 'no-api-key') return 'Сервер запущен без Steam API key — детальная статистика недоступна. Добавьте STEAM_API_KEY в .env, чтобы видеть K/D, винрейт и карты.';
    if (r === 'private-or-empty') return 'Игровая статистика скрыта в настройках приватности Steam, либо вы ещё не играли в CS2.';
    if (r === 'network') return 'Не удалось получить статистику из Steam. Попробуйте обновить страницу через пару минут.';
    if (r && r.startsWith('http-')) return `Steam вернул ошибку ${r.replace('http-', '')}. Возможно, профиль закрыт.`;
    return 'Статистика временно недоступна.';
  }
  return null;
}

function paintDashKpis(statsResp) {
  const root = $('#dash-kpis');
  if (!root) return;
  root.innerHTML = '';

  const reason = statsUnavailableReason(statsResp);
  const h = statsResp?.summary?.headline || {};
  const notes = statsResp?.summary?.notes;

  const cards = [
    { name: 'K/D',      val: h.kd != null ? h.kd.toFixed(2).replace('.', ',') : '—',
      tag: rateKd(h.kd), icon: 'kd' },
    { name: 'HS%',      val: h.hsRate != null ? fmtPct(h.hsRate, 1) : '—',
      tag: rateHs(h.hsRate), icon: 'crosshair' },
    { name: 'Точность', val: h.accuracy != null ? fmtPct(h.accuracy, 1) : '—',
      tag: rateAcc(h.accuracy), icon: 'target' },
    { name: 'Winrate',  val: h.winrate != null ? fmtPct(h.winrate, 1) : '—',
      tag: rateWr(h.winrate), icon: 'trend',
      sub: 'Только Comp.' },
    { name: 'Соревн. матчи', val: h.matches != null ? fmtNumber(h.matches) : '—',
      tag: { text: 'ВСЕГО', kind: 'dim' }, icon: 'grid' },
    { name: 'MVP',      val: h.mvps != null ? fmtNumber(h.mvps) : '—',
      tag: { text: 'НАГРАД', kind: 'dim' }, icon: 'star' }
  ];

  for (const c of cards) {
    root.appendChild(buildKpiCard(c));
  }

  if (reason) {
    // Stats unavailable — show error reason
    const note = el('div', { class: 'alert alert-warn',
      style: { gridColumn: '1 / -1', marginTop: '4px' } }, reason);
    root.appendChild(note);
  }
}

function rateKd(v) {
  if (v == null) return null;
  if (v >= 1.10) return { text: 'ХОРОШО', kind: 'good' };
  if (v >= 0.95) return { text: 'СРЕДНЕ', kind: 'mid' };
  return { text: 'НИЖЕ СРЕД.', kind: 'bad' };
}
function rateAcc(v) {
  if (v == null) return null;
  // These thresholds are for Steam lifetime accuracy (includes all-time CS:GO+CS2),
  // which is naturally lower than per-match accuracy due to warmup/spray practice.
  if (v >= 20) return { text: 'ХОРОШО', kind: 'good' };
  if (v >= 15) return { text: 'СРЕДНЕ', kind: 'mid' };
  return { text: 'НИЖЕ СРЕД.', kind: 'bad' };
}
function rateHs(v) {
  if (v == null) return null;
  if (v >= 45) return { text: 'ХОРОШО', kind: 'good' };
  if (v >= 35) return { text: 'СРЕДНЕ', kind: 'mid' };
  return { text: 'НИЖЕ СРЕД.', kind: 'bad' };
}
function rateWr(v) {
  if (v == null) return null;
  if (v >= 55) return { text: 'ХОРОШО', kind: 'good' };
  if (v >= 48) return { text: 'СРЕДНЕ', kind: 'mid' };
  return { text: 'НИЖЕ СРЕД.', kind: 'bad' };
}

function kpiIcoSvg(key) {
  const m = {
    kd:        '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    target:    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
    trend:     '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    grid:      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    star:      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
  };
  return m[key] || m.grid;
}

function buildKpiCard({ name, val, tag, icon }) {
  const card = el('div', { class: 'kpi' });
  card.appendChild(el('div', { class: 'kpi-top' },
    el('span', { class: 'kpi-ico', html:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${kpiIcoSvg(icon)}</svg>` }),
    el('span', { class: 'kpi-name' }, name)
  ));
  const valEl = el('div', { class: 'kpi-val' }, val);
  card.appendChild(valEl);
  // Count-up if val looks like a number
  animateNumber(valEl, val);
  if (tag) {
    card.appendChild(el('div', {
      class: 'kpi-sub' + (tag.kind === 'dim' ? ' dim' : tag.kind === 'good' ? '' : tag.kind === 'mid' ? ' mid' : ' bad')
    }, tag.text));
  }
  return card;
}

// Tween a number-looking text from 0 → final value over 700ms.
// Safe for non-numeric values (it just leaves them as-is).
function animateNumber(node, finalStr) {
  if (typeof finalStr !== 'string') return;
  // Extract sign, integer/decimal, and any suffix like %
  const m = finalStr.match(/^(-?)([\d\s\u00A0]+)([,.](\d+))?(.*)$/);
  if (!m) return;
  const sign = m[1] || '';
  const intStr = m[2].replace(/[\s\u00A0]/g, '');
  const decStr = m[4] || '';
  const suffix = m[5] || '';
  const finalNum = Number(sign + intStr + (decStr ? '.' + decStr : ''));
  if (!isFinite(finalNum)) return;
  if (Math.abs(finalNum) < 1) return; // skip tiny values like K/D 0.12
  const decimals = decStr.length;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const start = performance.now();
  const dur = 700;
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const v = finalNum * eased;
    node.textContent = formatTweenValue(v, decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
    else node.textContent = finalStr;
  }
  // Override starting text with 0 of the same shape
  node.textContent = (decimals ? '0' + (',').padEnd(decimals + 1, '0') : '0') + suffix;
  requestAnimationFrame(tick);
}

function formatTweenValue(v, decimals) {
  const fixed = v.toFixed(decimals).replace('.', ',');
  // Insert non-breaking thousand separators for the integer part
  const [int, dec] = fixed.split(',');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return dec ? `${intFmt},${dec}` : intFmt;
}

function paintDashRow1(statsResp) {
  const root = $('#dash-row1');
  if (!root) return;
  root.innerHTML = '';

  // 1) Last matches — slot filled later from Faceit (see paintDashMatches)
  const matchesSlot = el('div', { id: 'dash-matches-slot' });
  matchesSlot.appendChild(el('div', { class: 'card' },
    el('div', { class: 'loading-inline' }, el('div', { class: 'spinner sm' }), 'Загружаем матчи…')));
  root.appendChild(matchesSlot);

  // 2) Maps performance
  const maps = (statsResp?.summary?.maps || []).slice(0, 6);
  if (maps.length === 0) {
    root.appendChild(emptyCard('Производительность по картам',
      'Когда Steam-статистика станет доступна, здесь появятся винрейт и матчи по каждой карте.', '🗺️'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' },
      el('h2', null, 'Карты ',
        el('span', { class: 'lifetime-badge', title: 'Суммарно за CS:GO + CS2' }, 'Lifetime')
      ),
      el('a', { class: 'card-link', href: '#' }, 'Все ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' })
      )
    ));
    const tbl = el('div', { class: 'tbl tbl-maps' });
    tbl.appendChild(el('div', { class: 'tbl-head' },
      el('div', null, 'Карта'), el('div', null, 'Раунды'), el('div', null, 'Winrate'), el('div', null, 'Победы')));
    for (const m of maps) {
      const look = lookMap(m.map);
      const wr = m.winrate != null ? m.winrate : 0;
      tbl.appendChild(el('div', { class: 'tbl-row' },
        el('div', { class: 'map-cell' },
          mapIconEl(look),
          el('div', { class: 'map-name' }, look.name)
        ),
        el('div', null, fmtNumber(m.rounds)),
        el('div', { class: 'winrate-cell' },
          el('div', { class: 'winrate-bar' },
            el('div', { class: 'winrate-fill', style: { width: `${Math.min(100, Math.max(0, wr))}%` } })
          ),
          el('span', null, m.winrate != null ? `${m.winrate.toFixed(0)}%` : '—')
        ),
        el('div', null, fmtNumber(m.wins))
      ));
    }
    card.appendChild(tbl);
    root.appendChild(card);
  }

  // 3) Weapons performance
  const weapons = (statsResp?.summary?.weapons || []).slice(0, 6);
  if (weapons.length === 0) {
    root.appendChild(emptyCard('Производительность по оружию',
      'Сюда попадут убийства, точность и предпочтения по оружию из Steam-статистики.', '🔫'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' },
      el('h2', null, 'Оружие ',
        el('span', { class: 'lifetime-badge', title: 'Суммарно за CS:GO + CS2' }, 'Lifetime')
      ),
      el('a', { class: 'card-link', href: '#' }, 'Всё ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' })
      )
    ));
    const tbl = el('div', { class: 'tbl tbl-weapons' });
    tbl.appendChild(el('div', { class: 'tbl-head' },
      el('div', null, 'Оружие'), el('div', null, 'Убийства'), el('div', null, 'Выстрелы'), el('div', null, 'Точность')));
    for (const w of weapons) {
      const look = lookWeapon(w.weapon);
      tbl.appendChild(el('div', { class: 'tbl-row' },
        el('div', { class: 'w-cell' },
          weaponIconEl(look),
          el('div', { class: 'w-name' }, look.name)
        ),
        el('div', null, fmtNumber(w.kills)),
        el('div', null, fmtNumber(w.shots)),
        el('div', null, w.accuracy != null ? `${w.accuracy.toFixed(1)}%` : '—')
      ));
    }
    card.appendChild(tbl);
    root.appendChild(card);
  }
}

function paintDashRow2(statsResp) {
  const root = $('#dash-row2');
  if (!root) return;
  root.innerHTML = '';

  // 1) Played-with — slot filled later from Faceit (see paintDashTeammates)
  const teammatesSlot = el('div', { id: 'dash-teammates-slot' });
  teammatesSlot.appendChild(el('div', { class: 'card' },
    el('div', { class: 'loading-inline' }, el('div', { class: 'spinner sm' }), 'Загружаем тиммейтов…')));
  root.appendChild(teammatesSlot);

  // 2) Insights — derived from real stats
  const h = statsResp?.summary?.headline || {};
  const maps = statsResp?.summary?.maps || [];
  const weapons = statsResp?.summary?.weapons || [];
  const insights = [];

  if (maps.length >= 2) {
    const sorted = maps.slice().filter(m => m.winrate != null).sort((a, b) => a.winrate - b.winrate);
    if (sorted.length) {
      const worst = sorted[0];
      const best = sorted[sorted.length - 1];
      const wLook = lookMap(worst.map), bLook = lookMap(best.map);
      if (worst.winrate < 50) {
        insights.push({
          title: `Слабая карта — ${wLook.name}`,
          tag: { text: 'Карты' },
          desc: `Винрейт всего ${worst.winrate.toFixed(0)}% за ${worst.rounds} раундов. Подумайте о тренировке позиций или баннах в Премьер-режиме.`,
          ico: 'map'
        });
      }
      if (best.winrate >= 55) {
        insights.push({
          title: `Сильная карта — ${bLook.name}`,
          tag: { text: 'Карты' },
          desc: `Винрейт ${best.winrate.toFixed(0)}% за ${best.rounds} раундов — лучший результат в вашей сетке.`,
          ico: 'map'
        });
      }
    }
  }

  if (weapons.length) {
    const top = weapons[0];
    insights.push({
      title: `Любимое оружие — ${lookWeapon(top.weapon).name}`,
      tag: { text: 'Оружие', kind: 'shooting' },
      desc: `${fmtNumber(top.kills)} убийств${top.accuracy != null ? `, точность ${top.accuracy.toFixed(1)}%` : ''}. Опирайтесь на это в важных раундах.`,
      ico: 'target'
    });
  }

  if (h.hsRate != null) {
    if (h.hsRate >= 50) {
      insights.push({
        title: 'Высокий процент хедшотов',
        tag: { text: 'Стрельба', kind: 'shooting' },
        desc: `${h.hsRate.toFixed(1)}% попаданий — в голову. Отличный показатель аима.`,
        ico: 'crosshair'
      });
    } else if (h.hsRate < 35) {
      insights.push({
        title: 'Низкий HS%',
        tag: { text: 'Стрельба', kind: 'shooting' },
        desc: `Только ${h.hsRate.toFixed(1)}% убийств — в голову. Поработайте над высотой прицела и aim_botz.`,
        ico: 'crosshair'
      });
    }
  }

  if (h.kd != null && h.matches != null && h.matches >= 50) {
    if (h.kd < 1) {
      insights.push({
        title: 'K/D ниже 1.0',
        tag: { text: 'Геймплей', kind: 'gameplay' },
        desc: `Сейчас ${h.kd.toFixed(2)}. Старайтесь меньше «выходить первым» — играйте за тиммейтов и ищите трейды.`,
        ico: 'info'
      });
    }
  }

  if (insights.length === 0) {
    root.appendChild(emptyCard('Инсайты и рекомендации',
      'Инсайты появятся, когда у вас накопится достаточно сыгранных раундов в CS2.', '💡'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' }, el('h2', null, 'Инсайты и рекомендации')));
    for (const ins of insights.slice(0, 4)) {
      const tagClass = ins.tag?.kind === 'gameplay' ? 'gameplay' : ins.tag?.kind === 'shooting' ? 'shooting' : '';
      card.appendChild(el('div', { class: 'insight' },
        el('span', { class: 'ins-ico', html:
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${insIcoSvg(ins.ico)}</svg>` }),
        el('div', { class: 'ins-body' },
          el('div', { class: 'ins-head' },
            el('div', { class: 'ins-title' }, ins.title),
            ins.tag ? el('span', { class: `ins-tag ${tagClass}` }, ins.tag.text) : null
          ),
          el('div', { class: 'ins-desc' }, ins.desc)
        )
      ));
    }
    root.appendChild(card);
  }

  // 3) Extras — derived from totals
  const raw = statsResp?.summary?.raw || {};
  const extras = [
    { name: 'MVP-награды',    val: h.mvps != null ? fmtNumber(h.mvps) : null, sub: 'Всего' },
    { name: 'Бомбы установлены', val: h.planted != null ? fmtNumber(h.planted) : null, sub: 'Всего' },
    { name: 'Бомбы разминированы', val: h.defused != null ? fmtNumber(h.defused) : null, sub: 'Всего' },
    { name: 'Часы в CS2',     val: h.hours != null ? fmtNumber(h.hours, 0) + ' ч' : null, sub: 'Игровое время' }
  ].filter(e => e.val != null);

  if (extras.length === 0) {
    root.appendChild(emptyCard('Доп. статистика',
      'Сюда попадут MVP, бомбы, время в игре и другие суммарные метрики.', '📈'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' }, el('h2', null, 'Доп. статистика')));
    for (const x of extras) {
      card.appendChild(el('div', { class: 'xstat' },
        el('div', null,
          el('div', { class: 'xs-name' }, x.name),
          el('div', { class: 'xs-val' }, x.val),
          el('div', { class: 'xs-sub' }, x.sub)
        )
      ));
    }
    root.appendChild(card);
  }
}

function insIcoSvg(key) {
  const m = {
    map:       '<polyline points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>',
    target:    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    info:      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/>'
  };
  return m[key] || m.info;
}

// ============ rail-lookup (check someone else's profile from dashboard) ============
const LOOKUP_HISTORY_KEY = 'sok:lookupHistory';
const LOOKUP_HISTORY_MAX = 5;

function loadLookupHistory() {
  try {
    const raw = localStorage.getItem(LOOKUP_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => x && x.steamid).slice(0, LOOKUP_HISTORY_MAX) : [];
  } catch (_) { return []; }
}

function saveLookupHistoryItem(entry) {
  try {
    const cur = loadLookupHistory();
    // dedupe by steamid
    const filtered = cur.filter(x => x.steamid !== entry.steamid);
    filtered.unshift(entry);
    const trimmed = filtered.slice(0, LOOKUP_HISTORY_MAX);
    localStorage.setItem(LOOKUP_HISTORY_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch (_) { return loadLookupHistory(); }
}

function removeLookupHistoryItem(steamid) {
  try {
    const cur = loadLookupHistory().filter(x => x.steamid !== steamid);
    localStorage.setItem(LOOKUP_HISTORY_KEY, JSON.stringify(cur));
    return cur;
  } catch (_) { return loadLookupHistory(); }
}

function paintLookupHistory() {
  const root = $('#dash-recent');
  if (!root) return;
  root.innerHTML = '';
  const items = loadLookupHistory();
  if (items.length === 0) {
    root.appendChild(el('div', { class: 'rail-recent-empty' },
      'Последние проверенные аккаунты появятся здесь.'));
    return;
  }
  root.appendChild(el('div', { class: 'rail-recent-h' }, 'Последние проверенные'));
  for (const it of items) {
    const avatar = el('div', { class: 'rail-recent-avatar' });
    if (it.avatar) {
      const img = el('img', { src: it.avatar, alt: '', loading: 'lazy' });
      img.onload = function() { this.classList.add('loaded'); };
      img.onerror = function() {
        this.remove();
        avatar.textContent = (it.name || '?').slice(0, 1).toUpperCase();
      };
      avatar.appendChild(img);
    } else {
      avatar.textContent = (it.name || '?').slice(0, 1).toUpperCase();
    }

    const link = el('a', {
      class: 'rail-recent-item',
      href: `/lookup?steamid=${encId(it.steamid)}`
    },
      avatar,
      el('div', { style: { minWidth: 0 } },
        el('div', { class: 'rail-recent-name', title: it.name || it.steamid }, it.name || '—'),
        el('div', { class: 'rail-recent-sub' }, it.steamid.slice(-8))
      ),
      el('button', {
        class: 'rail-recent-x', type: 'button', title: 'Удалить из истории',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          removeLookupHistoryItem(it.steamid);
          paintLookupHistory();
        }
      }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' }))
    );

    root.appendChild(link);
  }
}

function wireDashLookup() {
  paintLookupHistory();
  const form = $('#dashLookupForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#dashLookupInput');
    const submitBtn = form.querySelector('button[type="submit"]');
    const val = (input?.value || '').trim();
    if (!val) { toast.warn('Введите SteamID или ссылку'); return; }

    const origText = submitBtn.textContent;
    submitBtn.disabled = true; submitBtn.textContent = 'Ищем…';
    try {
      const r = await api.resolve(val);
      if (!r.ok) {
        toast.err('Не нашли такого игрока в Steam');
        return;
      }
      // Try to enrich with profile data for the history entry
      let entry = { steamid: r.steamid, name: r.steamid, avatar: null, ts: Date.now() };
      try {
        const p = await api.profile(r.steamid);
        if (p?.profile) {
          entry.name = p.profile.personaname || r.steamid;
          entry.avatar = p.profile.avatar || p.profile.avatarfull || null;
        }
      } catch (_) {}
      saveLookupHistoryItem(entry);
      location.assign(`/lookup?steamid=${encId(r.steamid)}`);
    } catch (err) {
      toast.err('Не удалось разрешить SteamID');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = origText;
    }
  });
}


// ============ Faceit section on dashboard ============

// Faceit skill level colors — matches the official Faceit palette
const FACEIT_LEVEL_COLOR = {
  1:  '#eeeeee',  2:  '#5cba47',  3:  '#5cba47',  4:  '#ffc222',
  5:  '#ffc222',  6:  '#ffc222',  7:  '#ffc222',  8:  '#ff6c00',
  9:  '#ff6c00', 10:  '#ff0606'
};

// Fill the "Последние матчи" slot in row1 from Faceit data
function paintDashMatches(resp) {
  const slot = $('#dash-matches-slot');
  if (!slot) return;
  slot.innerHTML = '';

  if (!resp?.ok || !(resp.recentMatches || []).length) {
    slot.appendChild(emptyCard('Последние матчи',
      resp?.reason === 'no-api-key'
        ? 'Faceit API не настроен администратором.'
        : 'Faceit-матчи появятся, если у игрока есть аккаунт Faceit с историей CS2.',
      '🎯'));
    return;
  }

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-h' },
    el('h2', null, 'Последние матчи ',
      el('span', { class: 'lifetime-badge', style: { background: 'rgba(255,108,0,0.15)', color: '#ff8a3d', borderColor: 'rgba(255,108,0,0.4)' } }, 'Faceit')),
    resp.profile?.faceit_url ? el('a', { class: 'card-link', href: resp.profile.faceit_url, target: '_blank', rel: 'noopener' },
      'Все ',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' })
    ) : null
  ));
  const list = el('div', { class: 'fc-matches-list' });
  for (const m of resp.recentMatches.slice(0, 6)) {
    const look = lookMap(m.map);
    const dateStr = m.finished_at
      ? new Date(m.finished_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
      : (m.started_at ? new Date(m.started_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '');
    const statsRow = m.stats_ok ? el('div', { class: 'fc-match-stats' },
      el('span', { class: 'fc-stat', title: 'Kills / Deaths / Assists' },
        el('span', { class: 'k' }, String(m.kills ?? '—')),
        el('span', { class: 'sep' }, '/'),
        el('span', { class: 'd' }, String(m.deaths ?? '—')),
        el('span', { class: 'sep' }, '/'),
        el('span', { class: 'a' }, String(m.assists ?? '—'))
      ),
      m.kd != null ? el('span', { class: 'fc-stat' },
        el('span', { class: 'lbl' }, 'K/D'),
        el('span', { class: 'val ' + (m.kd >= 1.0 ? 'pos' : 'neg') }, m.kd.toFixed(2).replace('.', ','))
      ) : null,
      m.hs_pct != null ? el('span', { class: 'fc-stat' },
        el('span', { class: 'lbl' }, 'HS'),
        el('span', { class: 'val' }, `${m.hs_pct}%`)
      ) : null,
      m.adr != null ? el('span', { class: 'fc-stat' },
        el('span', { class: 'lbl' }, 'ADR'),
        el('span', { class: 'val' }, String(Math.round(m.adr)))
      ) : null
    ) : null;

    list.appendChild(el('a', {
      class: 'fc-match' + (m.is_win ? ' win' : ' loss'),
      href: m.faceit_url || '#', target: '_blank', rel: 'noopener'
    },
      el('div', { class: 'fc-match-row1' },
        (function(){const w=mapIconEl(look);w.className='fc-match-map-ico';return w;})(),
        el('div', { class: 'fc-match-info' },
          el('div', { class: 'fc-match-name' }, look.name),
          el('div', { class: 'fc-match-meta' }, dateStr, ' · ', m.competition_name)
        ),
        el('div', { class: 'fc-match-score ' + (m.is_win ? 'win' : 'loss') },
          el('span', null, m.our_score != null ? m.our_score : '?'),
          el('span', { class: 'sep' }, ':'),
          el('span', null, m.opp_score != null ? m.opp_score : '?')
        ),
        el('div', { class: 'fc-match-result' + (m.is_win ? ' win' : ' loss') },
          m.is_win ? 'Победа' : 'Поражение')
      ),
      statsRow
    ));
  }
  card.appendChild(list);
  slot.appendChild(card);
}

// Fill the "С кем играл" slot in row2 from Faceit teammates aggregate
function paintDashTeammates(resp) {
  const slot = $('#dash-teammates-slot');
  if (!slot) return;
  slot.innerHTML = '';

  if (!resp?.ok || !(resp.teammates || []).length) {
    slot.appendChild(emptyCard('С кем играл',
      resp?.reason === 'no-api-key'
        ? 'Faceit API не настроен администратором.'
        : 'Когда наберётся история Faceit-матчей, здесь появятся постоянные тиммейты и винрейт с ними.',
      '👥'));
    return;
  }

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-h' }, el('h2', null, 'С кем играл')));
  const list = el('div', { class: 'tbl tbl-players' });
  list.appendChild(el('div', { class: 'tbl-head' },
    el('div', null, 'Игрок'), el('div', null, 'Игр'), el('div', null, 'Winrate'), el('div', null, '')));
  for (const t of resp.teammates) {
    const avatar = el('div', { class: 'p-avatar' });
    if (t.avatar) {
      const img = el('img', { src: t.avatar, alt: '', loading: 'lazy' });
      img.onerror = function() { this.remove(); avatar.textContent = (t.nickname || '?').slice(0, 1).toUpperCase(); };
      avatar.appendChild(img);
    } else {
      avatar.textContent = (t.nickname || '?').slice(0, 1).toUpperCase();
    }
    const wr = t.winrate != null ? t.winrate : 0;
    list.appendChild(el('div', { class: 'tbl-row' },
      el('div', { class: 'p-cell' }, avatar, el('div', { class: 'p-name' }, t.nickname)),
      el('div', null, String(t.games)),
      el('div', { class: 'winrate-cell' },
        el('div', { class: 'winrate-bar' },
          el('div', { class: 'winrate-fill', style: { width: `${Math.min(100, Math.max(0, wr))}%`,
            background: wr >= 50 ? 'var(--g)' : 'var(--red)' } })
        ),
        el('span', null, t.winrate != null ? `${t.winrate}%` : '—')
      ),
      el('a', { class: 'p-check', href: `https://faceit.com/en/players/${encodeURIComponent(t.nickname)}`,
        target: '_blank', rel: 'noopener', title: 'Открыть на Faceit' },
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>' }))
    ));
  }
  card.appendChild(list);
  slot.appendChild(card);
}

function paintDashFaceit(resp) {
  const root = $('#dash-faceit');
  if (!root) return;
  root.innerHTML = '';

  if (!resp?.ok) {
    root.appendChild(buildFaceitEmpty(resp?.reason));
    return;
  }

  const { profile, headline, maps, recentMatches } = resp;
  const lvl = profile.cs2.skill_level;
  const elo = profile.cs2.faceit_elo;

  const card = el('div', { class: 'card faceit-card' });

  // Header
  const h = el('div', { class: 'fc-h' },
    el('div', { class: 'fc-h-left' },
      el('span', { class: 'fc-badge' }, 'FACEIT'),
      el('span', { style: { color: 'var(--dim)', fontSize: '12px' } },
        'Аналитика по матчам · CS2-only')
    ),
    profile.faceit_url ? el('a', {
      class: 'card-link', href: profile.faceit_url, target: '_blank', rel: 'noopener'
    }, 'Профиль на Faceit ',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })
    ) : null
  );
  card.appendChild(h);

  // Profile row: avatar + nick + level/elo + headline stats
  const profRow = el('div', { class: 'fc-prof' });

  // Avatar
  if (profile.avatar) {
    const a = el('img', { src: profile.avatar, alt: '', class: 'fc-avatar' });
    a.onerror = function() { this.style.display = 'none'; };
    profRow.appendChild(a);
  } else {
    profRow.appendChild(el('div', { class: 'fc-avatar fc-avatar-fb' },
      (profile.nickname || '?').slice(0, 1).toUpperCase()));
  }

  // Identity
  const ident = el('div', { class: 'fc-ident' },
    el('div', { class: 'fc-nick' }, profile.nickname,
      profile.verified ? el('span', { class: 'fc-verified', title: 'Verified', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }) : null
    ),
    el('div', { class: 'fc-sub' },
      profile.country ? el('span', null, profile.country.toUpperCase()) : null,
      profile.cs2.region ? el('span', null, ' · ', profile.cs2.region) : null
    )
  );

  // Level + elo block
  const lvlCol = FACEIT_LEVEL_COLOR[lvl] || 'var(--mute)';
  const levelBlock = el('div', { class: 'fc-level' },
    lvl ? el('div', { class: 'fc-level-ico', style: { background: lvlCol } }, String(lvl)) : null,
    el('div', null,
      el('div', { class: 'fc-level-label' }, lvl ? `Lvl ${lvl}` : 'Без уровня'),
      el('div', { class: 'fc-elo' }, elo != null ? `${fmtNumber(elo)} ELO` : '—')
    )
  );

  profRow.appendChild(ident);
  profRow.appendChild(levelBlock);

  // Right-aligned headline mini stats
  const mini = el('div', { class: 'fc-mini' });
  const miniStats = [
    { label: 'K/D',     val: headline.kdRatio != null ? headline.kdRatio.toFixed(2).replace('.', ',') : '—' },
    { label: 'HS%',     val: headline.headshotsPct != null ? `${headline.headshotsPct}%` : '—' },
    { label: 'Winrate', val: headline.winrate != null ? `${headline.winrate}%` : '—' },
    { label: 'Матчи',   val: headline.matches != null ? fmtNumber(headline.matches) : '—' }
  ];
  for (const m of miniStats) {
    mini.appendChild(el('div', { class: 'fc-mini-item' },
      el('div', { class: 'fc-mini-label' }, m.label),
      el('div', { class: 'fc-mini-val' }, m.val)
    ));
  }
  profRow.appendChild(mini);

  card.appendChild(profRow);

  // Recent results streak (last 5)
  if (headline.recentResults?.length) {
    const streak = el('div', { class: 'fc-streak' });
    streak.appendChild(el('span', { class: 'fc-streak-label' }, 'Последние:'));
    for (const r of headline.recentResults.slice(0, 5)) {
      const won = String(r) === '1';
      streak.appendChild(el('span', { class: 'fc-streak-pip ' + (won ? 'win' : 'loss'),
        title: won ? 'Победа' : 'Поражение' }, won ? 'W' : 'L'));
    }
    if (headline.currentWinStreak >= 2) {
      streak.appendChild(el('span', { class: 'fc-streak-note' },
        `Серия побед: ${headline.currentWinStreak}`));
    }
    card.appendChild(streak);
  }

  // Two-column inner: maps left, recent matches right
  const inner = el('div', { class: 'fc-inner fc-inner-single' });

  // Maps table (full width — matches now live in their own dashboard block)
  if (maps?.length) {
    const mapsBlock = el('div', { class: 'fc-maps' });
    mapsBlock.appendChild(el('div', { class: 'fc-block-h' }, 'Карты'));
    const tbl = el('div', { class: 'tbl tbl-maps fc-maps-tbl' });
    tbl.appendChild(el('div', { class: 'tbl-head' },
      el('div', null, 'Карта'), el('div', null, 'Матчи'),
      el('div', null, 'Winrate'), el('div', null, 'K/D')));
    for (const m of maps.slice(0, 7)) {
      const look = lookMap(m.map);
      const wr = m.winrate != null ? m.winrate : 0;
      tbl.appendChild(el('div', { class: 'tbl-row' },
        el('div', { class: 'map-cell' },
          mapIconEl(look),
          el('div', { class: 'map-name' }, look.name)
        ),
        el('div', null, fmtNumber(m.matches)),
        el('div', { class: 'winrate-cell' },
          el('div', { class: 'winrate-bar' },
            el('div', { class: 'winrate-fill',
              style: { width: `${Math.min(100, Math.max(0, wr))}%` } })
          ),
          el('span', null, m.winrate != null ? `${m.winrate.toFixed(0)}%` : '—')
        ),
        el('div', null, m.kd != null ? m.kd.toFixed(2).replace('.', ',') : '—')
      ));
    }
    mapsBlock.appendChild(tbl);
    inner.appendChild(mapsBlock);
  }

  if (inner.children.length) card.appendChild(inner);
  root.appendChild(card);
}

function buildFaceitEmpty(reason) {
  const card = el('div', { class: 'card faceit-card faceit-empty' });
  card.appendChild(el('div', { class: 'fc-h' },
    el('span', { class: 'fc-badge' }, 'FACEIT')
  ));

  let title = 'Faceit-профиль не найден';
  let desc = '';
  let cta = null;

  if (reason === 'no-api-key') {
    title = 'Faceit API не настроен';
    desc = 'Администратору нужно задать FACEIT_API_KEY в окружении, чтобы подтянуть аналитику с Faceit.';
  } else if (reason === 'not-found') {
    title = 'Faceit-профиль не найден';
    desc = 'Этот SteamID не привязан к Faceit-аккаунту. Если у тебя есть Faceit с другим Steam-аккаунтом, ' +
           'укажи свой Faceit-ник в настройках.';
    cta = { href: '/settings', text: 'Указать Faceit-ник' };
  } else if (reason === 'no-cs2-data') {
    title = 'У игрока нет CS2 на Faceit';
    desc = 'Faceit-профиль найден, но в нём не зарегистрирована CS2-активность.';
  } else if (reason === 'rate-limited') {
    title = 'Faceit ограничил запросы';
    desc = 'Слишком много запросов к Faceit API. Попробуйте через минуту.';
  } else if (reason === 'auth-error') {
    title = 'Faceit отверг ключ';
    desc = 'API key недействителен или истёк. Администратору нужно обновить FACEIT_API_KEY.';
  } else if (reason === 'network') {
    title = 'Faceit не отвечает';
    desc = 'Не удалось связаться с Faceit. Попробуйте обновить страницу через пару минут.';
  } else {
    desc = 'Не удалось получить данные с Faceit. Проверьте, что Faceit-профиль публичный и привязан к этому Steam.';
  }

  card.appendChild(el('div', { class: 'empty-state' },
    el('div', { class: 'icon' }, '🎯'),
    el('div', { class: 'title' }, title),
    el('div', { class: 'desc' }, desc),
    cta ? el('a', { class: 'btn btn-sm', href: cta.href, style: { marginTop: '12px' } }, cta.text) : null
  ));

  return card;
}


function paintDashNews(newsResp) {
  const root = $('#dash-news');
  if (!root) return;
  root.innerHTML = '';

  const wrap = el('div', { class: 'news-rail' });
  wrap.appendChild(el('div', { class: 'news-rail-h' },
    el('h3', null, 'Новости CS2'),
    el('a', { class: 'card-link', href: 'https://store.steampowered.com/news/app/730',
      target: '_blank', rel: 'noopener' }, 'Все',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' })
    )
  ));

  if (!newsResp?.ok || !newsResp.items?.length) {
    wrap.appendChild(el('div', { class: 'news-rail-empty' },
      'Не удалось получить новости из Steam. Попробуйте позже.'));
    root.appendChild(wrap);
    return;
  }

  const items = newsResp.items.slice(0, 3);
  for (const n of items) {
    const dateStr = n.date
      ? new Date(n.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
      : '';

    const thumbWrap = el('div', { class: 'news-rail-thumb' });
    if (n.image) {
      const img = el('img', { src: n.image, alt: '', loading: 'lazy' });
      img.onload = function() { this.classList.add('loaded'); };
      img.onerror = function() {
        this.remove();
        thumbWrap.insertAdjacentHTML('beforeend',
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>');
      };
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.insertAdjacentHTML('beforeend',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>');
    }

    wrap.appendChild(el('a', {
      class: 'news-rail-item', href: n.url, target: '_blank', rel: 'noopener'
    },
      thumbWrap,
      el('div', { class: 'news-rail-body' },
        el('div', { class: 'news-rail-date' }, dateStr),
        el('div', { class: 'news-rail-title', title: n.title }, n.title || 'Без заголовка'),
        el('div', { class: 'news-rail-desc' }, (n.contents || '').slice(0, 110))
      )
    ));
  }

  wrap.appendChild(el('a', {
    class: 'news-rail-footer',
    href: 'https://store.steampowered.com/news/app/730',
    target: '_blank', rel: 'noopener'
  }, 'Все новости в Steam →'));

  root.appendChild(wrap);
}

// ============ page: inventory ============
async function pageInventory() {
  const me = await renderTopbar('inventory');
  // Allow ?steamid=X to view someone else's inventory; else require own login
  const params = new URLSearchParams(location.search);
  const targetSteamId = params.get('steamid') || (me.logged_in ? me.steamid : null);
  if (!targetSteamId) {
    toast.warn('Войдите через Steam, чтобы увидеть инвентарь');
    setTimeout(() => location.replace('/'), 800);
    return;
  }
  const isOwn = me.logged_in && targetSteamId === me.steamid;
  const settings = (me.settings || {});
  const currency = settings.currency || 'RUB';

  // State for client-side filter/sort/pagination
  const state = {
    steamid: targetSteamId,
    currency,
    inv: null,
    history: null,
    priceMovers: null,
    search: '',
    cat: 'all',
    sort: 'price-desc',
    page: 1,
    perPage: 10,
    isOwn
  };
  window._invState = state;

  // Helper to render all inventory sections from current state
  const renderAll = () => {
    paintInvKpis(state);
    paintInvCats(state);
    paintInvLists(state);
    paintInvTable(state);
    paintInvAnalytics(state);
  };

  const refreshPriceMovers = async () => {
    if (!state.inv?.ok) return;
    const names = (state.inv.items || [])
      .filter(i => i.price_value != null && i.market_name)
      .map(i => i.market_name);
    if (!names.length) return;
    const r = await api.priceMovers(names, state.currency, 30).catch(() => null);
    if (!r?.ok) return;
    state.priceMovers = r.movers || [];
    paintInvLists(state);
  };

  // Shows a subtle "обновлено N мин назад / обновляем…" indicator near the refresh button
  const setFreshness = (text, busy) => {
    const el2 = $('#inv-freshness');
    if (el2) {
      el2.textContent = text || '';
      el2.classList.toggle('busy', !!busy);
    }
  };

  // History loads in parallel (cheap)
  const histPromise = api.inventoryHistory(targetSteamId).catch(() => ({ ok: false, snapshots: [] }));

  // Stage 1: instant response — server returns cache if it has one (≤24h), else does a live fetch.
  const first = await api.inventory(targetSteamId, { currency, cachedOk: true })
    .catch(e => ({ ok: false, status: 'error', error: String(e) }));
  state.inv = first;
  state.history = await histPromise;
  renderAll();
  refreshPriceMovers();

  if (first.cached) {
    const mins = Math.round((first.cache_age_ms || 0) / 60000);
    setFreshness(mins <= 1 ? 'обновлено только что' : `обновлено ${mins} мин назад`);
  }

  // Stage 2: if the served data was cached & stale (or wasn't cached cleanly), refresh in background.
  if (first.cached && first.stale) {
    setFreshness('обновляем…', true);
    api.inventory(targetSteamId, { currency, force: true })
      .then(fresh => {
        if (fresh && fresh.ok) {
          state.inv = fresh;
          renderAll();
          refreshPriceMovers();
          setFreshness('обновлено только что');
        } else {
          setFreshness('');
        }
      })
      .catch(() => setFreshness(''));
  }

  // Wire up the refresh button — always forces a live fetch
  const refreshBtn = $('#inv-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      const orig = refreshBtn.innerHTML;
      refreshBtn.innerHTML = 'Обновляем…';
      setFreshness('обновляем…', true);
      try {
        const [invR2, histR2] = await Promise.all([
          api.inventory(targetSteamId, { currency: state.currency, force: true }).catch(e => ({ ok: false, status: 'error' })),
          api.inventoryHistory(targetSteamId).catch(() => ({ ok: false, snapshots: [] }))
        ]);
        state.inv = invR2;
        state.history = histR2;
        renderAll();
        refreshPriceMovers();
        setFreshness('обновлено только что');
        toast.ok('Инвентарь обновлён');
      } catch (e) {
        toast.err('Не удалось обновить');
        setFreshness('');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = orig;
      }
    });
  }
}

function invStatusReason(status, httpStatus) {
  const map = {
    'private':       'Инвентарь скрыт настройками приватности Steam.',
    'parse-error':   'Не удалось разобрать ответ Steam.',
    'empty':         'Инвентарь пустой.',
    'network-error': 'Не удалось связаться со Steam Community.',
    'rate-limited':  'Steam ограничил запросы. Повторите через 1–2 минуты.',
    'error':         'Неизвестная ошибка.'
  };
  if (httpStatus === 403) return 'Профиль закрыт (403). Откройте инвентарь в настройках Steam.';
  if (httpStatus === 429) return 'Слишком много запросов (429). Подождите минуту.';
  return map[status] || 'Инвентарь временно недоступен.';
}

function paintInvKpis(state) {
  const root = $('#inv-kpis');
  if (!root) return;
  root.innerHTML = '';

  const inv = state.inv;
  if (!inv || !inv.ok) {
    root.appendChild(el('div', { class: 'alert alert-warn', style: { gridColumn: '1 / -1' } },
      invStatusReason(inv?.status, inv?.http_status)));
    return;
  }

  const totalVal = inv.total_value_text || (inv.total_value != null ? fmtPrice(inv.total_value, inv.currency) : '—');
  const priced = inv.pricing?.priced_items || 0;
  const unpriced = inv.pricing?.unpriced_items || 0;
  const total = priced + unpriced;
  const pricedPct = total ? (priced / total * 100).toFixed(1) : '0';

  // Compute change from history
  let changeText = '';
  let changeKind = 'dim';
  if (state.history?.snapshots?.length && inv.total_value != null) {
    const snaps = state.history.snapshots.filter(s => s.currency === inv.currency && s.total_value != null);
    if (snaps.length >= 1) {
      // pick the snapshot from ~24h ago, or oldest if fewer
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      let ref = snaps[0];
      for (const s of snaps) {
        const t = new Date(s.created_at).getTime();
        if (t <= dayAgo) { ref = s; break; }
      }
      const diff = inv.total_value - ref.total_value;
      const pct = ref.total_value ? (diff / ref.total_value * 100) : 0;
      if (Math.abs(pct) >= 0.1) {
        changeText = `${diff >= 0 ? '+' : ''}${fmtPrice(diff, inv.currency)} (${fmtPct(pct, 2, true)})`;
        changeKind = diff >= 0 ? 'good' : 'bad';
      }
    }
  }

  // Card 1: total value
  const card1 = el('div', { class: 'kpi' });
  card1.appendChild(el('div', { class: 'card-eyebrow', style: { marginBottom: '8px' } }, 'Общая стоимость'));
  card1.appendChild(el('div', { class: 'kpi-val', style: { fontSize: '32px' } }, totalVal));
  if (changeText) {
    card1.appendChild(el('div', {
      class: 'kpi-sub' + (changeKind === 'good' ? '' : changeKind === 'bad' ? ' bad' : ' dim')
    }, changeText));
  } else {
    card1.appendChild(el('div', { class: 'kpi-sub dim',
      style: { textTransform: 'none', fontSize: '12px', letterSpacing: 0, fontWeight: 500 } },
      'Изменение появится после повторного визита'));
  }
  root.appendChild(card1);

  // Card 2: priced items
  const card2 = el('div', { class: 'kpi' });
  card2.appendChild(el('div', { class: 'card-eyebrow', style: { marginBottom: '8px' } }, 'Предметов с ценой'));
  card2.appendChild(el('div', { class: 'kpi-val', style: { fontSize: '32px' }, html:
    `<span style="color:var(--g)">${priced}</span> <span style="color:var(--mute);font-weight:600">/ ${total}</span> <span style="font-size:14px;color:var(--dim);font-weight:600">${pricedPct}%</span>` }));
  card2.appendChild(el('div', { class: 'kpi-sub dim',
    style: { textTransform: 'none', fontSize: '12px', color: 'var(--dim)', fontWeight: 500, letterSpacing: 0 } },
    `Без цены: ${unpriced} предметов`));
  root.appendChild(card2);

  // Card 3: currency switcher
  const card3 = el('div', { class: 'kpi' });
  card3.appendChild(el('div', { class: 'card-eyebrow', style: { marginBottom: '8px' } }, 'Валюта'));
  const sel = el('select', { class: 'select',
    onchange: async (e) => {
      const newCur = e.target.value;
      if (newCur === state.currency) return;
      state.currency = newCur;
      root.innerHTML = ''; // re-show loading
      root.appendChild(el('div', { class: 'loading-inline', style: { gridColumn: '1 / -1' } },
        el('div', { class: 'spinner sm' }), 'Перезагружаем цены в ' + newCur + '…'));
      try {
        state.inv = await api.inventory(state.steamid, { currency: newCur });
        paintInvKpis(state); paintInvLists(state); paintInvTable(state); paintInvAnalytics(state);
      } catch (err) {
        toast.err('Ошибка при перезагрузке: ' + (err.message || err));
      }
    }
  });
  for (const code of ['RUB', 'USD', 'EUR']) {
    const opt = el('option', { value: code }, code === 'RUB' ? 'RUB (₽)' : code === 'USD' ? 'USD ($)' : 'EUR (€)');
    if (code === state.currency) opt.selected = true;
    sel.appendChild(opt);
  }
  const selWrap = el('div', { style: { position: 'relative', marginBottom: '8px' } }, sel);
  card3.appendChild(selWrap);
  card3.appendChild(el('div', { class: 'kpi-sub dim',
    style: { textTransform: 'none', fontSize: '11px', color: 'var(--dim)', fontWeight: 500, letterSpacing: 0, lineHeight: '1.5' },
    html: 'Цены из Steam Market.<br>Кэш — до 15 минут.' }));
  root.appendChild(card3);

  // Card 4: price sources
  const card4 = el('div', { class: 'kpi' });
  card4.appendChild(el('div', { class: 'card-eyebrow', style: { marginBottom: '10px' } }, 'Источники цен'));
  card4.appendChild(el('div', { class: 'src-list' },
    el('div', { class: 'src-row' },
      el('span', { class: 'src-name', html:
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0a12 12 0 0 0-11.93 11.06l6.43 2.66a3.4 3.4 0 0 1 1.92-.6h.17l2.85-4.13v-.06a4.55 4.55 0 1 1 4.55 4.55"/></svg>Steam' }),
      el('span', { class: 'src-val' }, totalVal !== '—' ? totalVal : '—', el('span', { class: 'pct' }, ' (100%)'))
    )
  ));
  card4.appendChild(el('div', { class: 'src-foot' }, 'Только Steam Market в текущей версии'));
  root.appendChild(card4);
}

function paintInvCats(state) {
  const root = $('#inv-cats');
  if (!root) return;
  root.innerHTML = '';

  const inv = state.inv;
  if (!inv?.ok) return;

  // Build category counts from item tags
  const cats = countCategories(inv.items || []);
  const all = inv.items?.length || 0;
  // image: PNG weapon silhouette path | emoji: fallback glyph | grid: special SVG
  const order = [
    { key: 'all',       label: 'Все',              grid: true },
    { key: 'rifle',     label: 'Винтовки',         image: '/assets/weapons/weapon_ak47.png' },
    { key: 'sniper',    label: 'Снайперские',      image: '/assets/weapons/weapon_awp.png' },
    { key: 'pistol',    label: 'Пистолеты',        image: '/assets/weapons/weapon_glock.png' },
    { key: 'smg',       label: 'Пистолеты-пулемёты', image: '/assets/weapons/weapon_mp9.png' },
    { key: 'mg',        label: 'Пулемёты',         image: '/assets/weapons/weapon_m249.png' },
    { key: 'shotgun',   label: 'Дробовики',        image: '/assets/weapons/weapon_nova.png' },
    { key: 'knife',     label: 'Ножи',             image: '/assets/weapons/weapon_knife.png' },
    { key: 'gloves',    label: 'Перчатки',         emoji: '🧤' },
    { key: 'sticker',   label: 'Наклейки',         emoji: '🏷️' },
    { key: 'agent',     label: 'Агенты',           emoji: '🪖' },
    { key: 'other',     label: 'Прочее',           emoji: '📦' }  // graffiti/cases/keys all fold here
  ];
  for (const c of order) {
    const cnt = c.key === 'all' ? all : (cats[c.key] || 0);
    if (cnt === 0 && c.key !== 'all') continue;
    const isActive = c.key === state.cat;
    const btn = el('button', {
      class: `cat-tab${isActive ? ' active' : ''}`, type: 'button',
      onclick: () => { state.cat = c.key; state.page = 1; paintInvCats(state); paintInvTable(state); }
    });
    // Icon
    if (c.grid) {
      btn.appendChild(el('span', { class: 'cat-ico', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>' }));
    } else if (c.image) {
      const ico = el('span', { class: 'cat-ico cat-ico-img' });
      const img = el('img', { src: c.image, alt: '', loading: 'lazy' });
      img.onerror = function() { this.remove(); ico.textContent = '🔫'; };
      ico.appendChild(img);
      btn.appendChild(ico);
    } else {
      btn.appendChild(el('span', { class: 'cat-ico' }, c.emoji));
    }
    btn.appendChild(el('span', { class: 'cat-label' }, c.label));
    btn.appendChild(el('span', { class: 'cnt' }, String(cnt)));
    root.appendChild(btn);
  }
}

function countCategories(items) {
  const out = {};
  for (const it of items) {
    const cat = categoryOf(it);
    out[cat] = (out[cat] || 0) + 1;
  }
  return out;
}

function categoryOf(item) {
  const tags = item.tags || [];
  const typeTag = tags.find(t => t.category === 'Type');
  const t = (typeTag?.internal_name || typeTag?.name || '').toLowerCase();
  // Map Steam type tags to our buckets
  if (t.includes('rifle') && !t.includes('sniper')) return 'rifle';
  if (t.includes('sniperrifle') || t.includes('sniper')) return 'sniper';
  if (t.includes('pistol')) return 'pistol';
  if (t.includes('smg')) return 'smg';
  if (t.includes('machinegun') || t === 'csgo_type_machinegun') return 'mg';
  if (t.includes('shotgun')) return 'shotgun';
  if (t.includes('knife') || t === 'csgo_type_knife') return 'knife';
  if (t.includes('hands') || t.includes('gloves')) return 'gloves';
  if (t.includes('sticker')) return 'sticker';
  if (t.includes('customplayer') || t.includes('agent')) return 'agent';
  // Everything else (graffiti, cases, keys, music kits, patches, pins, tools) → 'other'
  return 'other';
}

function paintInvLists(state) {
  const root = $('#inv-lists');
  if (!root) return;
  root.innerHTML = '';

  const inv = state.inv;
  if (!inv?.ok) {
    root.appendChild(el('div', { class: 'card', style: { gridColumn: '1 / -1' } },
      el('div', { class: 'empty-state' },
        el('div', { class: 'icon' }, '📊'),
        el('div', { class: 'desc' }, invStatusReason(inv?.status, inv?.http_status))
      )
    ));
    return;
  }

  // 1) Chart — dynamics from snapshot history (or empty)
  if (state.chartRange == null) state.chartRange = 30; // default 30d
  const chartCard = el('div', { class: 'card chart-card' });
  const ranges = [
    { key: 7,   label: '7д' },
    { key: 30,  label: '30д' },
    { key: 90,  label: '90д' },
    { key: 0,   label: 'Все' }
  ];
  const tabsEl = el('div', { class: 'chart-tabs' });
  for (const r of ranges) {
    tabsEl.appendChild(el('button', {
      class: 'tab' + (state.chartRange === r.key ? ' active' : ''), type: 'button',
      onclick: () => {
        state.chartRange = r.key;
        // re-render just the chart body + active tab
        for (const b of tabsEl.children) b.classList.remove('active');
        tabsEl.children[ranges.indexOf(r)].classList.add('active');
        renderChartBody();
      }
    }, r.label));
  }
  chartCard.appendChild(el('div', { class: 'card-h' },
    el('h3', { style: { color: 'var(--g)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: '11px' } }, 'Динамика стоимости'),
    tabsEl
  ));

  const chartBody = el('div', { class: 'chart-body' });
  chartCard.appendChild(chartBody);

  const renderChartBody = () => {
    chartBody.innerHTML = '';
    const allSnaps = (state.history?.snapshots || [])
      .filter(s => s.currency === inv.currency && s.total_value != null)
      .slice().reverse();
    // Append current visit value to the right edge
    let snaps = allSnaps.slice();
    if (inv.total_value != null) {
      snaps.push({
        currency: inv.currency, total_value: inv.total_value,
        total_value_text: inv.total_value_text, created_at: new Date().toISOString()
      });
    }
    // Filter by selected range (0 = all)
    if (state.chartRange > 0) {
      const cutoff = Date.now() - state.chartRange * 24 * 60 * 60 * 1000;
      const filtered = snaps.filter(s => Date.parse(s.created_at) >= cutoff);
      // Keep at least the last 2 points so the chart isn't empty for sparse history
      snaps = filtered.length >= 2 ? filtered : snaps.slice(-2);
    }
    if (snaps.length < 2) {
      chartBody.appendChild(el('div', { class: 'empty-state', style: { padding: '40px 16px' } },
        el('div', { class: 'icon' }, '📈'),
        el('div', { class: 'desc' }, 'История появится после нескольких визитов')
      ));
      return;
    }
    chartBody.appendChild(buildPriceChart(snaps, inv.currency));
    const first = snaps[0];
    const lbls = [first.created_at, snaps[Math.floor(snaps.length / 4)]?.created_at, snaps[Math.floor(snaps.length / 2)]?.created_at, snaps[Math.floor(snaps.length * 3 / 4)]?.created_at, snaps[snaps.length - 1].created_at]
      .filter(Boolean).map(iso => shortDate(iso));
    chartBody.appendChild(el('div', { class: 'chart-axis' }, ...lbls.map(l => el('span', null, l))));
  };
  renderChartBody();
  root.appendChild(chartCard);

  // 2) Top by value
  const topItems = (inv.items || [])
    .filter(i => i.price_value != null)
    .sort((a, b) => b.price_value - a.price_value)
    .slice(0, 5);
  const topCard = el('div', { class: 'card' });
  topCard.appendChild(el('div', { class: 'card-eyebrow' }, 'Топ по стоимости'));
  if (topItems.length === 0) {
    topCard.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'desc' }, 'Нет предметов с ценой')));
  } else {
    const list = el('div', { class: 'movers-list' });
    topItems.forEach((it, i) => list.appendChild(buildMoverRow(i + 1, it, inv.currency)));
    topCard.appendChild(list);
  }
  root.appendChild(topCard);

  // 3) & 4) Risers / Fallers — derived from snapshot diff
  const movers = computeMovers(inv, state.history, state.priceMovers);
  const upCard = el('div', { class: 'card' });
  upCard.appendChild(el('div', { class: 'card-eyebrow', style: { color: 'var(--g)' } }, 'Лидеры роста'));
  if (movers.up.length === 0) {
    upCard.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'desc' }, state.priceMovers == null
        ? 'Считаем изменения по истории цен…'
        : 'Пока нет предметов с заметным ростом цены.')));
  } else {
    const list = el('div', { class: 'movers-list' });
    movers.up.forEach((m, i) => list.appendChild(buildMoverDelta(m, inv.currency, 'up')));
    upCard.appendChild(list);
  }
  root.appendChild(upCard);

  const downCard = el('div', { class: 'card' });
  downCard.appendChild(el('div', { class: 'card-eyebrow', style: { color: 'var(--red)' } }, 'Лидеры падения'));
  if (movers.down.length === 0) {
    downCard.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'desc' }, state.priceMovers == null
        ? 'Считаем изменения по истории цен…'
        : 'Пока нет предметов с заметным падением цены.')));
  } else {
    const list = el('div', { class: 'movers-list' });
    movers.down.forEach((m, i) => list.appendChild(buildMoverDelta(m, inv.currency, 'down')));
    downCard.appendChild(list);
  }
  root.appendChild(downCard);
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function buildPriceChart(snaps, currency) {
  const W = 400, H = 200;
  const vals = snaps.map(s => Number(s.total_value));
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = Math.max(1, max - min);
  const pad = range * 0.1;
  const yMin = Math.max(0, min - pad), yMax = max + pad;
  const xFor = (i) => (i / Math.max(1, snaps.length - 1)) * W;
  const yFor = (v) => H - ((v - yMin) / (yMax - yMin)) * H;
  let line = '', area = '';
  snaps.forEach((s, i) => {
    const x = xFor(i), y = yFor(Number(s.total_value));
    line += (i === 0 ? 'M' : ' L') + x.toFixed(1) + ' ' + y.toFixed(1);
  });
  area = line + ` L${W} ${H} L0 ${H} Z`;
  const last = snaps[snaps.length - 1];
  const lastX = xFor(snaps.length - 1), lastY = yFor(Number(last.total_value));

  const wrap = el('div', { class: 'chart-area', html:
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="cg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#4ade80" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#4ade80" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="50" x2="${W}" y2="50" stroke="#1b2522" stroke-width="0.5" stroke-dasharray="2,2"/>
      <line x1="0" y1="100" x2="${W}" y2="100" stroke="#1b2522" stroke-width="0.5" stroke-dasharray="2,2"/>
      <line x1="0" y1="150" x2="${W}" y2="150" stroke="#1b2522" stroke-width="0.5" stroke-dasharray="2,2"/>
      <path d="${area}" fill="url(#cg)"/>
      <path d="${line}" stroke="#4ade80" stroke-width="2" fill="none"/>
      <line x1="${lastX.toFixed(1)}" y1="0" x2="${lastX.toFixed(1)}" y2="${H}" stroke="#4ade80" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.5"/>
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="#4ade80"/>
    </svg>
    <div class="chart-tip" style="top:${Math.max(8, lastY - 30).toFixed(0)}px;right:${Math.max(8, W - lastX - 60).toFixed(0)}px">
      <div class="tip-date">${shortDate(last.created_at)}</div>
      <div class="tip-val">${fmtPrice(Number(last.total_value), currency)}</div>
    </div>` });
  return wrap;
}

function buildMoverRow(rank, item, currency) {
  return el('div', { class: 'mv-item' },
    el('div', { class: 'mv-rank' }, rank + '.'),
    el('div', { class: 'mv-info' },
      buildItemThumb(item, 'mv-img'),
      el('div', null,
        el('div', { class: 'mv-name', title: item.market_name }, item.market_name),
        el('div', { class: 'mv-meta' }, wearOf(item) || '—')
      )
    ),
    el('div', { class: 'mv-price' },
      el('div', { class: 'p1' }, item.price_text || fmtPrice(item.price_value, currency))
    )
  );
}

function buildItemThumb(item, className) {
  const wrap = el('div', { class: className, style: { background: gradientForItem(item) } });
  if (item.icon_url) {
    const img = el('img', {
      src: item.icon_url, alt: '', loading: 'lazy',
      style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block',
        opacity: '0', transition: 'opacity 0.3s ease' }
    });
    img.onload = function() { this.style.opacity = '1'; };
    img.onerror = function() {
      this.remove();
      wrap.appendChild(document.createTextNode(emojiForItem(item)));
    };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(document.createTextNode(emojiForItem(item)));
  }
  return wrap;
}

function buildMoverDelta(m, currency, dir) {
  const sign = dir === 'up' ? '+' : '';
  return el('div', { class: 'mv-item' },
    el('div', { class: 'mv-info', style: { gridColumn: '1 / 3' } },
      el('div', { class: 'mv-img', style: { background: m.grad || 'linear-gradient(135deg,#444,#222)' } }, m.emoji || '🎯'),
      el('div', null,
        el('div', { class: 'mv-name', title: m.name }, m.name)
      )
    ),
    el('div', { class: 'mv-price' },
      el('div', { class: 'p2 ' + dir }, `${sign}${m.pct.toFixed(1)}%`),
      el('div', { class: 'p1' }, `${sign}${fmtPrice(Math.abs(m.diff), currency)}`)
    )
  );
}

function computeMovers(inv, history, priceMovers = null) {
  const out = { up: [], down: [] };
  if (Array.isArray(priceMovers) && priceMovers.length) {
    const itemMap = new Map((inv.items || []).map(it => [it.market_name, it]));
    const deltas = priceMovers
      .map(m => {
        const it = itemMap.get(m.name);
        return {
          name: m.name,
          diff: Number(m.diff),
          pct: Number(m.pct),
          grad: it ? gradientForItem(it) : 'linear-gradient(135deg,#444,#222)',
          emoji: it ? emojiForItem(it) : '🎯'
        };
      })
      .filter(m => Number.isFinite(m.diff) && Number.isFinite(m.pct) && Math.abs(m.diff) >= 0.01);
    deltas.sort((a, b) => b.pct - a.pct);
    out.up = deltas.filter(d => d.diff > 0).slice(0, 4);
    out.down = deltas.filter(d => d.diff < 0).sort((a, b) => a.pct - b.pct).slice(0, 4);
    return out;
  }
  if (!history?.snapshots?.length) return out;
  // Last snapshot's stored "items" array is just top10 with name+value
  const snaps = history.snapshots.filter(s => s.currency === inv.currency && Array.isArray(s.items));
  if (!snaps.length) return out;
  // Most recent (excluding current call's just-saved snap if same minute)
  const last = snaps[0];
  const prevMap = new Map();
  for (const it of (last.items || [])) {
    if (it && it.name && it.value != null) prevMap.set(it.name, Number(it.value));
  }
  if (prevMap.size === 0) return out;

  const deltas = [];
  for (const it of (inv.items || [])) {
    if (it.price_value == null) continue;
    const prev = prevMap.get(it.market_name);
    if (prev == null || prev <= 0) continue;
    const diff = it.price_value - prev;
    if (Math.abs(diff) < 0.01) continue;
    const pct = diff / prev * 100;
    deltas.push({
      name: it.market_name, diff, pct,
      grad: gradientForItem(it), emoji: emojiForItem(it)
    });
  }
  deltas.sort((a, b) => b.pct - a.pct);
  out.up = deltas.filter(d => d.diff > 0).slice(0, 4);
  out.down = deltas.filter(d => d.diff < 0).slice(-4).reverse();
  return out;
}

function gradientForItem(item) {
  // Use the rarity color from Steam if available, else fallback gradient
  const rarityTag = (item.tags || []).find(t => t.category === 'Rarity');
  if (item.color && /^[0-9a-fA-F]{6}$/.test(item.color)) {
    return `linear-gradient(135deg, #${item.color}, #${darken(item.color)})`;
  }
  return 'linear-gradient(135deg,#4a4a4a,#2a2a2a)';
}
function darken(hex) {
  const r = Math.max(0, parseInt(hex.slice(0, 2), 16) - 60);
  const g = Math.max(0, parseInt(hex.slice(2, 4), 16) - 60);
  const b = Math.max(0, parseInt(hex.slice(4, 6), 16) - 60);
  return [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}
function emojiForItem(item) {
  const cat = categoryOf(item);
  return { rifle: '🔫', sniper: '🎯', pistol: '🔫', mg: '🔫', shotgun: '🔫', smg: '🔫',
    knife: '🔪', gloves: '🧤', sticker: '🏷️', graffiti: '🎨', case: '📦', key: '🗝️', agent: '👤', other: '✕' }[cat];
}
function wearOf(item) {
  const tags = item.tags || [];
  const wear = tags.find(t => t.category === 'Exterior' || t.category === 'Quality');
  return wear?.name || '';
}
// Short readable rarity labels — Steam returns long Russian names like
// "Тайное оружие экстраординарного типа" which break narrow table cells.
const RARITY_SHORT = {
  // RU (CS2 RU client)
  'обычное оружие': 'Обычное',
  'обычное снаряжение': 'Обычное',
  'обычный предмет': 'Обычное',
  'промышленное оружие': 'Промышл.',
  'промышленное снаряжение': 'Промышл.',
  'армейское оружие': 'Армейское',
  'армейское снаряжение': 'Армейское',
  'запрещённое оружие': 'Запрещ.',
  'запрещённое снаряжение': 'Запрещ.',
  'засекреченное оружие': 'Засекреч.',
  'засекреченное снаряжение': 'Засекреч.',
  'засекреченный предмет': 'Засекреч.',
  'тайное оружие': 'Тайное',
  'тайное снаряжение': 'Тайное',
  'предмет экстраординарного типа': 'Экстраорд.',
  'тайное оружие экстраординарного типа': 'Экстраорд.',
  'контрабанда': 'Контрабанда',
  // EN fallback
  'consumer grade': 'Common',
  'industrial grade': 'Industrial',
  'mil-spec grade': 'Mil-Spec',
  'restricted': 'Restricted',
  'classified': 'Classified',
  'covert': 'Covert',
  'extraordinary': 'Extraord.',
  'contraband': 'Contraband'
};
function rarityShort(name) {
  const k = String(name || '').trim().toLowerCase();
  return RARITY_SHORT[k] || name || '';
}

function rarityOf(item) {
  const tag = (item.tags || []).find(t => t.category === 'Rarity');
  if (!tag) return { name: '', short: '', color: '#666' };
  const full = tag.name || '';
  return {
    name: full,
    short: rarityShort(full),
    color: item.color ? '#' + item.color : '#666'
  };
}

function paintInvTable(state) {
  const root = $('#inv-items-wrap');
  if (!root) return;
  root.innerHTML = '';

  const inv = state.inv;
  if (!inv?.ok) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty-state' },
        el('div', { class: 'icon' }, '⚠️'),
        el('div', { class: 'title' }, 'Не удалось загрузить инвентарь'),
        el('div', { class: 'desc' }, invStatusReason(inv?.status, inv?.http_status))
      )
    ));
    return;
  }

  // Apply category filter
  let items = (inv.items || []);
  if (state.cat !== 'all') {
    items = items.filter(it => categoryOf(it) === state.cat);
  }
  // Apply search filter
  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter(it => (it.market_name || '').toLowerCase().includes(q));
  }
  // Sort
  switch (state.sort) {
    case 'price-asc':  items.sort((a, b) => (a.price_value ?? Infinity) - (b.price_value ?? Infinity)); break;
    case 'name-asc':   items.sort((a, b) => (a.market_name || '').localeCompare(b.market_name || '', 'ru')); break;
    case 'name-desc':  items.sort((a, b) => (b.market_name || '').localeCompare(a.market_name || '', 'ru')); break;
    case 'price-desc':
    default:           items.sort((a, b) => (b.price_value ?? -1) - (a.price_value ?? -1));
  }

  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / state.perPage));
  if (state.page > totalPages) state.page = totalPages;
  const startIdx = (state.page - 1) * state.perPage;
  const pageItems = items.slice(startIdx, startIdx + state.perPage);

  const card = el('div', { class: 'card flush', style: { padding: 0 } });

  // Header + toolbar
  const head = el('div', { style: { padding: '20px 22px 0' } });
  head.appendChild(el('div', { class: 'items-h' },
    el('h2', null, 'Ваши предметы'),
    el('span', { class: 'cnt' }, String(totalCount))
  ));
  const toolbar = el('div', { class: 'items-toolbar' });
  // Search
  const searchInput = el('input', {
    class: 'input', placeholder: 'Поиск по названию',
    value: state.search,
    oninput: debounce((e) => { state.search = e.target.value; state.page = 1; paintInvTable(state); }, 200)
  });
  toolbar.appendChild(el('div', { class: 'input-with-icon' },
    el('span', { class: 'ic', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' }),
    searchInput
  ));
  // Sort
  const sortSel = el('select', {
    class: 'select',
    onchange: (e) => { state.sort = e.target.value; paintInvTable(state); }
  });
  for (const opt of [
    { v: 'price-desc', l: 'Цена ↓' },
    { v: 'price-asc',  l: 'Цена ↑' },
    { v: 'name-asc',   l: 'Название А→Я' },
    { v: 'name-desc',  l: 'Название Я→А' }
  ]) {
    const o = el('option', { value: opt.v }, 'Сортировка: ' + opt.l);
    if (opt.v === state.sort) o.selected = true;
    sortSel.appendChild(o);
  }
  toolbar.appendChild(sortSel);
  head.appendChild(toolbar);
  card.appendChild(head);

  // Table
  const tbl = el('div', { class: 'items-table' });
  tbl.appendChild(el('div', { class: 'it-head' },
    el('div', null, 'Предмет'), el('div', null, 'Состояние'),
    el('div', null, 'Редкость'), el('div', null, 'Цена'),
    el('div', null, 'Источник'), el('div', null, 'Действия')
  ));

  if (pageItems.length === 0) {
    tbl.appendChild(el('div', { style: { padding: '40px 22px', textAlign: 'center', color: 'var(--dim)' } },
      'Ничего не найдено'));
  } else {
    for (const it of pageItems) {
      tbl.appendChild(buildItemRow(it, inv.currency));
    }
  }
  card.appendChild(tbl);

  // Pagination
  card.appendChild(buildPagination(state, totalCount, totalPages));

  root.appendChild(card);
}

function buildItemRow(it, currency) {
  const rar = rarityOf(it);
  const wear = wearOf(it);
  const isStar = (it.name || '').startsWith('★');
  const priced = it.price_value != null;
  const priceText = it.price_text || (priced ? fmtPrice(it.price_value, currency) : 'нет цены');

  const row = el('div', { class: 'it-row',
    style: { borderLeft: `3px solid ${rar.color}` } });

  // Thumb: 48×36 with real Steam icon, falls back to emoji
  const thumb = el('div', {
    style: {
      width: '48px', height: '36px', borderRadius: '6px',
      background: gradientForItem(it),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, overflow: 'hidden'
    }
  });
  if (it.icon_url) {
    const img = el('img', {
      src: it.icon_url, alt: '', loading: 'lazy',
      style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block',
        opacity: '0', transition: 'opacity 0.3s ease' }
    });
    img.onload = function() { this.style.opacity = '1'; };
    img.onerror = function() {
      this.remove();
      thumb.appendChild(document.createTextNode(emojiForItem(it)));
    };
    thumb.appendChild(img);
  } else {
    thumb.appendChild(document.createTextNode(emojiForItem(it)));
  }

  row.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 } },
    thumb,
    el('div', { style: { fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: it.market_name },
      (isStar ? '★ ' : '') + (it.market_name || '')
    )
  ));

  row.appendChild(el('div', null,
    wear ? el('div', null, wear) : el('div', { style: { color: 'var(--mute)' } }, '—'),
    it.tradable ? null : el('div', { style: { fontSize: '11px', color: 'var(--mute)', marginTop: '2px' } }, 'не tradable')
  ));

  row.appendChild(el('div', {
    style: { color: rar.color, fontWeight: 700, whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis' },
    title: rar.name
  }, rar.short || rar.name || '—'));

  const priceCell = el('div', null,
    el('div', { style: { fontWeight: 700, color: priced ? 'var(--text)' : 'var(--mute)',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, priceText)
  );
  if (it.price_stale) {
    priceCell.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--yellow)', fontWeight: 600, marginTop: '2px' } }, 'кэш'));
  } else if (priced && it.price_cached) {
    priceCell.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--dim)', fontWeight: 600, marginTop: '2px' } }, 'кэш'));
  }
  row.appendChild(priceCell);

  row.appendChild(el('div', null, it.price_source || (priced ? 'Steam' : '—')));

  row.appendChild(el('div', { class: 'it-actions' },
    el('a', {
      title: 'Открыть на Steam Market',
      href: `https://steamcommunity.com/market/listings/730/${encodeURIComponent(it.market_hash_name)}`,
      target: '_blank', rel: 'noopener'
    }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })),
    el('button', { title: 'Добавить в watchlist',
      onclick: () => toggleWatch(it.market_hash_name, true) },
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' })
    )
  ));

  return row;
}

function buildPagination(state, totalCount, totalPages) {
  const pag = el('div', { class: 'pagination' });
  const pages = el('div', { class: 'pg-pages' });

  // Prev
  pages.appendChild(el('button', {
    class: 'pg-btn', disabled: state.page <= 1,
    onclick: () => { if (state.page > 1) { state.page--; paintInvTable(state); } }
  }, el('span', { html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>' })));

  // Page numbers — show first, current+/-1, last, with ellipsis
  const visiblePages = computeVisiblePages(state.page, totalPages);
  for (const p of visiblePages) {
    if (p === '...') {
      pages.appendChild(el('button', { class: 'pg-btn', disabled: true }, '…'));
    } else {
      pages.appendChild(el('button', {
        class: 'pg-btn' + (p === state.page ? ' active' : ''),
        onclick: () => { state.page = p; paintInvTable(state); }
      }, String(p)));
    }
  }

  // Next
  pages.appendChild(el('button', {
    class: 'pg-btn', disabled: state.page >= totalPages,
    onclick: () => { if (state.page < totalPages) { state.page++; paintInvTable(state); } }
  }, el('span', { html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' })));

  pag.appendChild(pages);

  const startIdx = (state.page - 1) * state.perPage;
  const endIdx = Math.min(totalCount, startIdx + state.perPage);
  const right = el('div', { class: 'pg-right' });
  right.appendChild(el('span', null, totalCount === 0
    ? 'Нет предметов'
    : `Показано ${startIdx + 1}–${endIdx} из ${totalCount}`));
  const perPageSel = el('select', {
    class: 'select',
    onchange: (e) => { state.perPage = Number(e.target.value); state.page = 1; paintInvTable(state); }
  });
  for (const n of [10, 25, 50, 100]) {
    const o = el('option', { value: String(n) }, `${n} на странице`);
    if (n === state.perPage) o.selected = true;
    perPageSel.appendChild(o);
  }
  right.appendChild(perPageSel);
  pag.appendChild(right);

  return pag;
}

function computeVisiblePages(current, total) {
  if (total <= 7) {
    const arr = [];
    for (let i = 1; i <= total; i++) arr.push(i);
    return arr;
  }
  const out = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) out.push('...');
  for (let i = left; i <= right; i++) out.push(i);
  if (right < total - 1) out.push('...');
  out.push(total);
  return out;
}

function paintInvAnalytics(state) {
  const root = $('#inv-analytics');
  if (!root) return;
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'card-eyebrow' }, 'Аналитика инвентаря'));

  const inv = state.inv;
  if (!inv?.ok) {
    root.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'desc' }, 'Аналитика появится, когда инвентарь будет доступен.')
    ));
    return;
  }

  // Portfolio score — simple heuristic
  const items = inv.items || [];
  const priced = items.filter(i => i.price_value != null);
  const totalCount = items.length || 1;
  const pricedPct = priced.length / totalCount;
  // Diversity: unique categories
  const cats = new Set(items.map(categoryOf));
  const diversity = Math.min(1, cats.size / 6);
  // Concentration risk: if top item is >50% of total
  const total = priced.reduce((s, i) => s + i.price_value, 0);
  const topVal = priced.length ? Math.max(...priced.map(i => i.price_value)) : 0;
  const topShare = total ? topVal / total : 0;
  const concPenalty = topShare > 0.5 ? (topShare - 0.5) : 0;
  const score = Math.round(Math.max(0, Math.min(100, (pricedPct * 50 + diversity * 30 + 20 - concPenalty * 40))));
  const grade = score >= 80 ? 'Отличное' : score >= 65 ? 'Хорошее' : score >= 50 ? 'Среднее' : 'Слабое';

  // Portfolio block
  const portCirc = 2 * Math.PI * 26; // ~163.4
  const offset = portCirc - (score / 100) * portCirc;
  root.appendChild(el('div', { class: 'a-block' },
    el('div', { class: 'a-eyebrow' }, 'Состояние портфеля'),
    el('div', { class: 'portfolio-top' },
      el('div', null, el('div', { class: 'portfolio-grade' }, grade)),
      el('div', { class: 'portfolio-ring', html:
        `<svg viewBox="0 0 60 60" width="60" height="60">
          <circle cx="30" cy="30" r="26" fill="none" stroke="#1b2522" stroke-width="5"/>
          <circle cx="30" cy="30" r="26" fill="none" stroke="#4ade80" stroke-width="5" stroke-linecap="round"
            stroke-dasharray="${portCirc.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
        </svg>
        <div class="pr-text">${score}<span style="font-size:9px;font-weight:600;color:var(--dim);margin-left:1px">/100</span></div>` })
    ),
    el('div', { class: 'portfolio-desc' },
      `Покрытие ценами: ${(pricedPct * 100).toFixed(0)}%. `,
      topShare > 0 ? el('span', { class: 'green' },
        `Топ-предмет — ${(topShare * 100).toFixed(0)}% портфеля.`) : null
    )
  ));

  // Recommendations (derived)
  const recs = [];
  if (priced.length) {
    const topItem = priced.sort((a, b) => b.price_value - a.price_value)[0];
    recs.push({
      kind: 'rec',
      ico: 'star',
      title: `Самый ценный — ${topItem.market_name.slice(0, 30)}${topItem.market_name.length > 30 ? '…' : ''}`,
      desc: `${topItem.price_text || fmtPrice(topItem.price_value, inv.currency)} • держите под рукой Steam Market`
    });
  }
  if (inv.pricing?.unpriced_items > 0) {
    recs.push({
      kind: 'rec',
      ico: 'clock',
      title: `${inv.pricing.unpriced_items} предметов без цены`,
      desc: 'Возможно, не tradable или новые. Цены подтянутся в следующих запросах.'
    });
  }
  if (topShare > 0.5) {
    recs.push({
      kind: 'alert-red',
      ico: 'alert',
      title: 'Высокая концентрация в одном предмете',
      desc: 'Доля одного предмета — больше половины портфеля. Подумайте о диверсификации.'
    });
  }
  if (inv.pricing?.skipped_due_to_limit > 0) {
    recs.push({
      kind: 'rec',
      ico: 'clock',
      title: `Загружено ${inv.pricing.fetched_unique_names} из ${inv.pricing.unique_names} уникальных`,
      desc: `Steam ограничивает запросы. Остальные ${inv.pricing.skipped_due_to_limit} подтянутся при следующем визите.`
    });
  }

  if (recs.length) {
    const block = el('div', { class: 'a-block' });
    block.appendChild(el('div', { class: 'a-eyebrow' }, 'Рекомендации'));
    for (const r of recs) {
      const cls = r.kind === 'alert-red' ? 'alert-item red' : r.kind === 'alert' ? 'alert-item' : 'rec-item';
      const icoCls = r.kind.startsWith('alert') ? 'ai-ico' : 'ri-ico';
      const titleCls = r.kind.startsWith('alert') ? 'ai-title' : 'ri-title';
      const descCls = r.kind.startsWith('alert') ? 'ai-desc' : 'ri-desc';
      block.appendChild(el('div', { class: cls },
        el('span', { class: icoCls, html:
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${recIcoSvg(r.ico)}</svg>` }),
        el('div', null,
          el('div', { class: titleCls }, r.title),
          el('div', { class: descCls }, r.desc)
        )
      ));
    }
    root.appendChild(block);
  }

  // Actions block (static)
  root.appendChild(el('div', { class: 'a-block' },
    el('div', { class: 'a-eyebrow' }, 'Полезные действия'),
    el('div', { class: 'actions-list' },
      el('a', { class: 'act-item',
        href: `https://steamcommunity.com/profiles/${state.steamid}/inventory/#730`,
        target: '_blank', rel: 'noopener' },
        'Открыть инвентарь в Steam ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })
      ),
      el('a', { class: 'act-item',
        href: `https://steamcommunity.com/market/search?appid=730`,
        target: '_blank', rel: 'noopener' },
        'Открыть Steam Market ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })
      )
    )
  ));
}

function recIcoSvg(key) {
  const m = {
    star:  '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/>'
  };
  return m[key] || m.clock;
}

// ============ kept helpers (used by lookup page) ============
function renderItemCard(item, currency, opts = {}) {
  const watching = opts.watching || false;
  return el('div', { class: 'item-card' },
    el('img', { class: 'item-img', src: item.icon_url || '', alt: '', loading: 'lazy',
      onerror: function() { this.style.opacity = '0'; } }),
    el('div', { class: 'item-name', title: item.market_name }, item.market_name),
    el('div', { class: `item-price ${item.price_value == null ? 'unpriced' : ''}` },
      item.price_value != null
        ? fmtPrice(item.price_value, currency)
        : (item.price_reason === 'rate-limited' ? 'rate-limit' : 'нет цены')
    ),
    opts.actions !== false ? el('div', { class: 'item-actions' },
      el('button', {
        class: `icon-btn${watching ? ' active' : ''}`,
        title: watching ? 'Убрать из watchlist' : 'Добавить в watchlist',
        onclick: () => toggleWatch(item.market_hash_name, !watching)
      }, watching ? '✓' : '★')
    ) : null
  );
}

async function toggleWatch(marketName, addIt) {
  try {
    if (addIt) {
      await api.watchlist.add({ market_name: marketName });
      track('watchlist_added', { target: marketName });
      toast.ok('Добавлено в watchlist');
    } else {
      await api.watchlist.remove(marketName);
      toast.ok('Убрано из watchlist');
    }
  } catch (e) {
    toast.err('Не удалось обновить watchlist');
  }
}

// ============ trust signals (computed from profile/bans/stats/inventory/faceit) ============
//
// Returns a list of flags, each with severity 'red' | 'yellow' | 'green' + a description.
// Frontend uses this to render the summary banner and to put borders on relevant cards.
function computeTrustFlags({ profR, bansR, statsR, invR, faceitR, repR }) {
  const flags = [];
  const profile = profR?.profile || {};
  const bans = bansR?.ok ? bansR.data : null;

  // --- Hard red flags from Steam bans ---
  if (bans) {
    if (bans.vac_banned || bans.number_of_vac_bans > 0) {
      const n = bans.number_of_vac_bans || 1;
      const days = bans.days_since_last_ban || 0;
      flags.push({
        severity: 'red', area: 'profile',
        title: `VAC ban${n > 1 ? `s · ${n}` : ''}`,
        desc: days > 0
          ? `Получен ${days} ${pluralDays(days)} назад. VAC бан — это блокировка Valve за читы.`
          : 'Аккаунт забанен Valve по системе VAC.'
      });
    }
    if (bans.number_of_game_bans > 0) {
      flags.push({
        severity: 'red', area: 'profile',
        title: `Game ban${bans.number_of_game_bans > 1 ? 's · ' + bans.number_of_game_bans : ''}`,
        desc: 'Бан от разработчика за нарушения в конкретной игре. У CS2 такие баны выдают за читы и оскорбления.'
      });
    }
    if (bans.community_banned) {
      flags.push({
        severity: 'red', area: 'profile',
        title: 'Community ban',
        desc: 'Аккаунт заблокирован в Steam Community — обычно за фрод или спам.'
      });
    }
    if (bans.economy_ban && bans.economy_ban !== 'none') {
      flags.push({
        severity: 'yellow', area: 'profile',
        title: `Trade ban · ${bans.economy_ban}`,
        desc: 'Запрет на обмен предметами. Не всегда связан с читами, но повод обратить внимание.'
      });
    }
  }

  // --- Account age (timecreated is unix seconds) ---
  const tc = Number(profile.timecreated);
  if (tc > 0) {
    const ageMs = Date.now() - tc * 1000;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    if (ageDays < 30) {
      flags.push({
        severity: 'red', area: 'profile',
        title: 'Свежий аккаунт',
        desc: `Создан ${ageDays} ${pluralDays(ageDays)} назад. Очень молодой Steam — частый признак сменного смурфа после бана.`
      });
    } else if (ageDays < 180) {
      flags.push({
        severity: 'yellow', area: 'profile',
        title: 'Молодой аккаунт',
        desc: `Создан ${Math.round(ageDays / 30)} мес. назад. У легитимных игроков обычно аккаунт постарше.`
      });
    } else if (ageDays > 5 * 365) {
      flags.push({
        severity: 'green', area: 'profile',
        title: 'Старый аккаунт',
        desc: `${Math.floor(ageDays / 365)} лет в Steam — это плюс к доверию.`
      });
    }
  }

  // --- Privacy state ---
  const vis = Number(profile.communityvisibilitystate || 0);
  const invPrivate = invR?.ok === false && invR?.status === 'private';
  const profPrivate = vis !== 3;
  if (profPrivate) {
    flags.push({
      severity: 'yellow', area: 'profile',
      title: 'Профиль закрыт',
      desc: 'Профиль не публичный. Часть проверок невозможна.'
    });
  }
  if (invPrivate) {
    flags.push({
      severity: 'yellow', area: 'inventory',
      title: 'Инвентарь скрыт',
      desc: 'Игрок скрыл свой CS-инвентарь. Если другое тоже скрыто — больше повод насторожиться.'
    });
  }

  // --- Steam stats anomalies (lifetime) ---
  const h = statsR?.summary?.headline || {};
  if (h.accuracy != null && h.accuracy > 35) {
    flags.push({
      severity: 'yellow', area: 'stats',
      title: `Точность ${h.accuracy.toFixed(1)}%`,
      desc: 'Lifetime-точность > 35% встречается крайне редко. Возможен aimbot или мало сыгранных раундов.'
    });
  }
  if (h.hsRate != null && h.hsRate > 65) {
    flags.push({
      severity: 'yellow', area: 'stats',
      title: `HS% ${h.hsRate.toFixed(1)}%`,
      desc: 'Lifetime-процент хедшотов > 65% подозрителен — у обычных игроков 35–55%.'
    });
  }
  if (h.hours != null && h.hours < 50 && h.kd != null && h.kd > 1.3) {
    flags.push({
      severity: 'yellow', area: 'stats',
      title: 'Высокий K/D при малом отыгранном времени',
      desc: `Всего ${h.hours.toFixed(0)} ч в CS, но K/D ${h.kd.toFixed(2)}. Возможен смурф или буст.`
    });
  }

  // --- Faceit anomalies ---
  const fc = faceitR?.ok ? faceitR : null;
  if (fc) {
    const lvl = fc.profile?.cs2?.skill_level;
    const matches = fc.headline?.matches;
    if (lvl && lvl >= 9 && matches != null && matches < 100) {
      flags.push({
        severity: 'yellow', area: 'faceit',
        title: `Faceit Lvl ${lvl} при ${matches} матчах`,
        desc: 'Такой уровень за столь короткий период часто означает буст или смурф-аккаунт.'
      });
    }
    if (fc.headline?.kdRatio != null && fc.headline.kdRatio >= 1.5 && matches >= 20) {
      flags.push({
        severity: 'yellow', area: 'faceit',
        title: `Очень высокий Faceit K/D · ${fc.headline.kdRatio.toFixed(2)}`,
        desc: `K/D ≥ 1.5 на дистанции ${matches} матчей — топ-1% игроков.`
      });
    }
  }

  // --- Steam stats exist but no Faceit profile despite high Steam K/D ---
  if (!fc && h.kd != null && h.kd > 1.3 && h.matches != null && h.matches > 50 && faceitR?.reason === 'not-found') {
    flags.push({
      severity: 'yellow', area: 'faceit',
      title: 'Нет Faceit-аккаунта при высоком K/D в Steam',
      desc: 'Skillful-игроки обычно играют на Faceit. Отсутствие Faceit при заметном Steam K/D — повод проверить.'
    });
  }

  // --- Inventory tiny ---
  if (invR?.ok && (invR.items || []).length === 0) {
    flags.push({
      severity: 'yellow', area: 'inventory',
      title: 'Пустой инвентарь',
      desc: 'Никаких предметов CS — характерно для свежих смурф-аккаунтов.'
    });
  }

  // --- Community reputation signals ---
  const rep = repR?.ok ? repR : null;
  if (rep && (rep.byCat || {}).cheater) {
    const cheaterReports = rep.byCat.cheater;
    const hasVac = bans && (bans.vac_banned || bans.number_of_vac_bans > 0 || bans.number_of_game_bans > 0);
    if (cheaterReports >= 3 && hasVac) {
      // Reports corroborated by an actual ban — strong red
      flags.push({
        severity: 'red', area: 'reputation',
        title: `Сообщество: ${cheaterReports} репортов «читер» + бан`,
        desc: 'Игроки отмечают читы, и это подтверждается баном Valve. Серьёзный сигнал.'
      });
    } else if (cheaterReports >= 5) {
      flags.push({
        severity: 'red', area: 'reputation',
        title: `Сообщество: ${cheaterReports} репортов «читер»`,
        desc: 'Много игроков отметили этого человека как читера. Это субъективно, но повод насторожиться.'
      });
    } else if (cheaterReports >= 2) {
      flags.push({
        severity: 'yellow', area: 'reputation',
        title: `Сообщество: ${cheaterReports} репортов «читер»`,
        desc: 'Несколько игроков пожаловались на читы. Мнение сообщества, не официальный бан.'
      });
    }
  }
  if (rep && rep.label === 'good' && rep.praise >= 5) {
    flags.push({
      severity: 'green', area: 'reputation',
      title: `Сообщество: хорошая репутация (${rep.praise} 👍)`,
      desc: 'Игроки чаще хвалят этого человека, чем жалуются.'
    });
  }

  return flags;
}

function pluralDays(n) {
  // Russian plural for "день"
  const k = n % 100; if (k > 10 && k < 20) return 'дней';
  const k2 = n % 10;
  if (k2 === 1) return 'день';
  if (k2 >= 2 && k2 <= 4) return 'дня';
  return 'дней';
}

function paintTrustBanner(flags) {
  const root = $('#lk-trust');
  if (!root) return;
  root.innerHTML = '';

  const counts = { red: 0, yellow: 0, green: 0 };
  for (const f of flags) counts[f.severity] = (counts[f.severity] || 0) + 1;

  const worst = counts.red > 0 ? 'red' : counts.yellow > 0 ? 'yellow' : 'green';
  const titleByWorst = {
    red:    counts.red === 1 ? '1 красный флаг' : `${counts.red} красных флага${counts.red >= 5 ? 'в' : ''}`,
    yellow: counts.yellow === 1 ? '1 жёлтый флаг' : `${counts.yellow} жёлтых флага${counts.yellow >= 5 ? 'в' : ''}`,
    green:  'Чистый аккаунт'
  };
  const subByWorst = {
    red:    'Серьёзные признаки ненадёжности. Раскройте список ниже.',
    yellow: 'Замечены настораживающие сигналы. Не критично, но имейте в виду.',
    green:  'Никаких подозрительных признаков не обнаружено.'
  };
  const iconByWorst = {
    red:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    yellow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    green:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  // Banner
  const banner = el('div', { class: `trust-banner trust-${worst}` });
  banner.appendChild(el('div', { class: 'tb-ico', html: iconByWorst[worst] }));
  banner.appendChild(el('div', { class: 'tb-body' },
    el('div', { class: 'tb-title' }, titleByWorst[worst]),
    el('div', { class: 'tb-sub' }, subByWorst[worst])
  ));
  // Pip summary on the right (red / yellow / green counts)
  banner.appendChild(el('div', { class: 'tb-pips' },
    counts.red ? el('span', { class: 'pip pip-red',
      title: `${counts.red} красных` }, String(counts.red)) : null,
    counts.yellow ? el('span', { class: 'pip pip-yellow',
      title: `${counts.yellow} жёлтых` }, String(counts.yellow)) : null,
    counts.green ? el('span', { class: 'pip pip-green',
      title: `${counts.green} зелёных` }, String(counts.green)) : null
  ));
  root.appendChild(banner);

  // Detailed list (collapsible)
  if (flags.length) {
    const list = el('div', { class: 'trust-list' });
    // Sort: red → yellow → green; stable otherwise
    const order = { red: 0, yellow: 1, green: 2 };
    const sorted = flags.slice().sort((a, b) => order[a.severity] - order[b.severity]);
    for (const f of sorted) {
      list.appendChild(el('div', { class: `trust-item trust-${f.severity}` },
        el('span', { class: 'ti-dot' }),
        el('div', null,
          el('div', { class: 'ti-title' }, f.title),
          el('div', { class: 'ti-desc' }, f.desc)
        )
      ));
    }
    root.appendChild(list);
  }
}

// Apply severity border to a card based on which areas have flags
function applyCardSeverity(rootEl, flags, area) {
  if (!rootEl) return;
  const here = flags.filter(f => f.area === area);
  // strip any previous class first
  rootEl.classList.remove('flag-red', 'flag-yellow');
  if (here.some(f => f.severity === 'red')) rootEl.classList.add('flag-red');
  else if (here.some(f => f.severity === 'yellow')) rootEl.classList.add('flag-yellow');
}

// ============ page: lookup ============
async function pageLookup() {
  const me = await renderTopbar();
  const params = new URLSearchParams(location.search);
  const steamid = params.get('steamid');

  if (!steamid || !isSiteUserId(steamid)) {
    const root = $('#lk-profile');
    if (root) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'alert alert-warn' }, 'Не указан корректный SteamID (17 цифр).'));
    }
    return;
  }

  // Back link goes to dashboard if logged in, else home
  const back = $('#lk-back');
  if (back && me.logged_in) {
    back.setAttribute('href', '/dashboard');
    back.lastChild.textContent = ' Назад в дашборд';
  }

  // Pull everything in parallel — profile, bans, inventory, Steam stats, history, Faceit, Leetify, reputation
  const [profR, bansR, invR, statsR, histR, faceitR, leetifyR, repR] = await Promise.all([
    api.profile(steamid).catch(() => ({ ok: false })),
    api.bans(steamid).catch(() => ({ ok: false, reason: 'network' })),
    api.inventory(steamid, { currency: (me.settings?.currency || 'RUB'), noPrices: false, cachedOk: true })
      .catch(() => ({ ok: false, status: 'error' })),
    api.stats(steamid).catch(() => ({ ok: false, reason: 'network', items: [], summary: null })),
    api.inventoryHistory(steamid).catch(() => ({ ok: false, snapshots: [] })),
    api.faceit(steamid, { matches: 10 }).catch(() => ({ ok: false, reason: 'network' })),
    api.leetify(steamid).catch(() => ({ ok: false, reason: 'network' })),
    api.reputation.get(steamid).catch(() => ({ ok: false }))
  ]);

  if (profR?.ok) track('lookup_success', { target: steamid });
  if (invR?.ok && invR.total_value != null) track('inventory_value_shown', { target: steamid });

  // Update lookup history (skip own profile)
  if (profR?.profile && (!me.logged_in || me.steamid !== steamid)) {
    saveLookupHistoryItem({
      steamid,
      name: profR.profile.personaname || steamid,
      avatar: profR.profile.avatar || profR.profile.avatarfull || null,
      ts: Date.now()
    });
  }

  // Compute trust flags and paint the banner first (top of page)
  const flags = computeTrustFlags({ profR, bansR, statsR, invR, faceitR, repR });
  paintTrustBanner(flags);

  // Paint each block
  paintLookupProfile(profR, statsR, invR, bansR);
  if (me.logged_in && me.steamid !== steamid) {
    paintLookupSocial(steamid, profR);
  }
  paintReputation(steamid, repR, me);
  paintLookupFriends(steamid);
  paintLookupFaceit(faceitR);
  paintLookupLeetify(leetifyR);
  paintLookupActivity(steamid);
  paintLookupInvKpis(invR, histR);
  paintLookupStatsKpis(statsR);
  paintLookupTables(statsR);
  paintLookupTopItems(invR);

  // Apply severity borders to cards based on which area each flag belongs to
  applyCardSeverity($('#lk-profile')?.querySelector('.card'), flags, 'profile');
  applyCardSeverity($('#lk-faceit')?.querySelector('.card'), flags, 'faceit');
  applyCardSeverity($('#lk-inv-kpis')?.querySelector('.card'), flags, 'inventory');
  applyCardSeverity($('#lk-stats-kpis')?.querySelector('.card'), flags, 'stats');
  applyCardSeverity($('#lk-reputation')?.querySelector('.card'), flags, 'reputation');
}

function paintLookupFaceit(faceitR) {
  const root = $('#lk-faceit');
  if (!root) return;
  root.innerHTML = '';
  // Reuse the same renderer as the dashboard. We need a target div with id="dash-faceit"
  // because paintDashFaceit selects by that id, so swap temporarily.
  const inner = el('div', { id: 'dash-faceit' });
  root.appendChild(inner);
  paintDashFaceit(faceitR);
  // restore id to avoid collisions with anything else that might query it later
  inner.id = 'lk-faceit-inner';
}

// ============ Reputation (social credit) UI ============
const REP_CATS = [
  { key: 'cheater',   label: 'Читер',          emoji: '🚫', kind: 'bad'  },
  { key: 'toxic',     label: 'Токсик',         emoji: '🤬', kind: 'bad'  },
  { key: 'griefer',   label: 'Тимкилл/гриф',   emoji: '💢', kind: 'bad'  },
  { key: 'good_mate', label: 'Хороший тиммейт',emoji: '🤝', kind: 'good' },
  { key: 'caller',    label: 'Каллит',         emoji: '🎙️', kind: 'good' },
  { key: 'clutch',    label: 'Клатчер',        emoji: '🔥', kind: 'good' }
];
const REP_CAT_MAP = Object.fromEntries(REP_CATS.map(c => [c.key, c]));

async function paintLookupSocial(steamid, profR) {
  const root = $('#lk-social');
  if (!root) return;
  root.innerHTML = '';
  const name = profR?.profile?.personaname || 'игрок';
  const me = window.__me;
  const card = el('div', { class: 'card lk-social-card' });
  const actions = el('div', { class: 'lk-social-actions' });
  const rerender = () => paintLookupSocial(steamid, profR);

  // Anonymous: show login + share only, skip friend/block actions
  if (!me?.logged_in) {
    actions.appendChild(el('a', { class: 'btn lk-social-primary', href: '/auth/steam',
      onclick: typeof steamLogin === 'function' ? steamLogin : null
    }, 'Войти и добавить в друзья'));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: () => openShareProfileModal(steamid, name, profR?.profile),
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>Поделиться'
    }));
    card.appendChild(actions);
    root.appendChild(card);
    return;
  }

  // Own profile view — show owner controls instead of social actions.
  // This is the page other users see, so it's also useful to view as the owner
  // ("how do I look to others?"). The dashboard URL is now reserved for analytics.
  if (me.steamid === steamid) {
    actions.appendChild(el('div', { class: 'lk-social-hint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      el('span', { html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' }),
      'Это ваша публичная страница — как её видят другие'
    ));
    if (!isSteamId(me.steamid)) {
      actions.appendChild(el('div', { class: 'lk-social-hint lk-social-steam-hint' },
        'Вы вошли через Telegram. Подключите Steam, чтобы открыть CS2-статистику, инвентарь и полноценную проверку профиля.'
      ));
      actions.appendChild(el('a', { class: 'btn lk-social-primary', href: '/auth/steam', onclick: typeof steamLogin === 'function' ? steamLogin : null },
        'Подключить Steam'));
    }
    actions.appendChild(el('a', { class: 'btn', href: '/settings',
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Редактировать профиль'
    }));
    actions.appendChild(el('a', { class: 'btn btn-ghost', href: '/dashboard',
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>Открыть дашборд'
    }));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: () => openShareProfileModal(steamid, name, profR?.profile),
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>Поделиться'
    }));
    card.appendChild(actions);
    root.appendChild(card);
    return;
  }

  // Fetch current relationship status
  let status = 'none';
  try { const r = await api.friendStatus(steamid); status = r?.status || 'none'; } catch (_) {}

  if (status === 'friends') {
    actions.appendChild(el('a', { class: 'btn lk-social-primary', href: `/messages?to=${encId(steamid)}` }, 'Написать'));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: async () => { if (confirm(`Удалить ${name} из друзей?`)) { await api.friendRemove(steamid); toast.ok('Удалён из друзей'); rerender(); } } }, 'Удалить из друзей'));
  } else if (status === 'incoming') {
    actions.appendChild(el('div', { class: 'lk-social-hint' }, `${name} хочет добавить вас в друзья`));
    actions.appendChild(el('button', { class: 'btn lk-social-primary', type: 'button',
      onclick: async () => { await api.friendAccept(steamid); toast.ok('Заявка принята'); rerender(); } }, 'Принять заявку'));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: async () => { await api.friendRemove(steamid); rerender(); } }, 'Отклонить'));
  } else if (status === 'outgoing') {
    actions.appendChild(el('div', { class: 'lk-social-hint' }, 'Заявка отправлена, ожидает подтверждения'));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: async () => { await api.friendRemove(steamid); rerender(); } }, 'Отменить заявку'));
  } else if (status === 'blocked') {
    actions.appendChild(el('div', { class: 'lk-social-hint' }, 'Пользователь в чёрном списке'));
    actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
      onclick: async () => { await api.unblock(steamid); toast.ok('Разблокирован'); rerender(); } }, 'Разблокировать'));
  } else {
    actions.appendChild(el('button', { class: 'btn lk-social-primary', type: 'button',
      onclick: async () => {
        const r = await api.friendRequest(steamid).catch(() => ({ ok: false }));
        if (r.ok) { toast.ok('Заявка отправлена'); rerender(); }
        else toast.err(r.error === 'blocked' ? 'Недоступно' : 'Не удалось');
      } }, 'Добавить в друзья'));
  }

  // Block action (except when already blocked)
  if (status !== 'blocked') {
    actions.appendChild(el('button', { class: 'btn btn-ghost lk-social-block', type: 'button',
      onclick: async () => {
        if (!confirm(`Заблокировать ${name}? Дружба и переписка будут разорваны.`)) return;
        await api.block(steamid); toast.ok('Заблокирован'); rerender();
      } }, 'Заблокировать'));
  }

  // Share — visible to everyone, even anonymous. Drives virality.
  actions.appendChild(el('button', { class: 'btn btn-ghost', type: 'button',
    onclick: () => openShareProfileModal(steamid, name, profR?.profile),
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>Поделиться'
  }));

  card.appendChild(actions);
  root.appendChild(card);
}

// Share profile link: copy + send to friend in DM
function openShareProfileModal(steamid, name, profile) {
  const link = isSteamId(steamid)
    ? `${location.origin}/u/${encId(steamid)}`
    : `${location.origin}/lookup?steamid=${encId(steamid)}`;
  const me = window.__me;
  const listBox = el('div', { class: 'share-list' });

  const content = [
    el('div', { class: 'modal-hint' },
      'Поделитесь карточкой игрока. При отправке в Telegram, VK или Discord — появляется превью с аватаром и статистикой.'),
    el('div', { class: 'share-link-row' },
      el('input', { class: 'modal-input', readonly: 'readonly', value: link }),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(link); track('profile_shared', { target: steamid }); toast.ok('Скопировано'); }
        catch (_) { toast.warn('Скопируйте вручную'); }
      } }, 'Копировать')
    )
  ];

  // Native share API on mobile
  if (navigator.share) {
    content.push(el('button', { class: 'btn btn-full', type: 'button', style: { marginTop: '8px' },
      onclick: async () => {
        try { await navigator.share({ title: `Профиль ${name} на SOKOLENOK`, url: link }); track('profile_shared', { target: steamid }); }
        catch (_) { /* user cancelled */ }
      }
    }, 'Открыть «Поделиться…»'));
  }

  if (me?.logged_in) {
    content.push(el('label', { class: 'modal-label', style: { marginTop: '8px' } }, 'Или отправить другу на сайте'));
    content.push(listBox);
  }

  openModal(`Поделиться · ${name}`, content, async () => true, 'Закрыть');

  if (me?.logged_in) {
    listBox.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Друзья…</div>';
    api.friends().then(r => {
      const friends = r?.friends || [];
      listBox.innerHTML = '';
      if (!friends.length) {
        listBox.appendChild(el('div', { class: 'share-empty' }, 'Друзей на сайте пока нет.'));
        return;
      }
      for (const f of friends) {
        const row = el('button', { class: 'share-row', type: 'button' });
        const ava = el('div', { class: 'share-ava' });
        if (f.avatar) {
          const img = el('img', { src: f.avatar, alt: '' });
          img.onerror = function() { this.remove(); ava.textContent = (f.name || '?').slice(0,1).toUpperCase(); };
          ava.appendChild(img);
        } else ava.textContent = (f.name || '?').slice(0,1).toUpperCase();
        row.appendChild(ava);
        row.appendChild(el('div', { class: 'share-name' }, f.name));
        const sendBtn = el('span', { class: 'share-send-tag' }, 'Отправить');
        row.appendChild(sendBtn);
        row.addEventListener('click', async () => {
          row.disabled = true; sendBtn.textContent = '…';
          const res = await api.sendMessage(f.steam_id, '', { type: 'profile', steam_id: steamid }).catch(() => ({ ok: false }));
          if (res.ok) { track('profile_shared', { target: steamid }); sendBtn.textContent = 'Отправлено ✓'; sendBtn.classList.add('sent'); }
          else { sendBtn.textContent = 'Ошибка'; row.disabled = false; }
        });
        listBox.appendChild(row);
      }
    }).catch(() => { listBox.innerHTML = ''; });
  }
}

// Block of in-site friends shown on every profile page.
async function paintLookupFriends(steamid) {
  const root = $('#lk-friends');
  if (!root) return;
  root.innerHTML = '';
  const r = await api.friendsOf(steamid).catch(() => ({ ok: false, friends: [] }));
  if (!r.ok || !r.friends?.length) return; // nothing to show — hide block entirely

  const card = el('div', { class: 'card lk-friends-card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, `Друзья на сайте · ${r.count}`));
  const grid = el('div', { class: 'lk-friends-grid' });
  for (const f of r.friends.slice(0, 12)) {
    const ava = el('div', { class: 'lk-friend-ava' });
    if (f.avatar) {
      const img = el('img', { src: f.avatar, alt: '', loading: 'lazy' });
      img.onerror = function() { this.remove(); ava.textContent = (f.name || '?').slice(0, 1).toUpperCase(); };
      ava.appendChild(img);
    } else ava.textContent = (f.name || '?').slice(0, 1).toUpperCase();
    grid.appendChild(el('a', { class: 'lk-friend', href: `/lookup?steamid=${encId(f.steam_id)}`, title: f.name },
      ava, el('div', { class: 'lk-friend-name' }, f.name || f.steam_id.slice(-6))
    ));
  }
  card.appendChild(grid);
  if (r.count > 12) {
    card.appendChild(el('div', { class: 'lk-friends-more' }, `+${r.count - 12} ещё`));
  }
  root.appendChild(card);
}

function paintReputation(steamid, repR, me) {
  const root = $('#lk-reputation');
  if (!root) return;
  root.innerHTML = '';

  const card = el('div', { class: 'card rep-card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Репутация сообщества'));

  const agg = repR?.ok ? repR : { total: 0, praise: 0, reports: 0, score: 0, byCat: {}, label: 'neutral', comments: [], my_vote: null, can_vote: false };

  // Summary line
  const labelText = {
    good:    'Хорошая репутация',
    bad:     'Плохая репутация',
    mixed:   'Смешанная репутация',
    neutral: agg.total > 0 ? 'Мало оценок' : 'Пока нет оценок'
  }[agg.label] || 'Пока нет оценок';
  const labelKind = agg.label === 'good' ? 'good' : agg.label === 'bad' ? 'bad' : agg.label === 'mixed' ? 'mixed' : 'neutral';

  const jumpToVote = (lean) => {
    const vw = root.querySelector('.rep-vote');
    if (!vw) {
      // not logged in or own profile — nothing to jump to
      if (!me?.logged_in) toast.warn('Войдите через Steam, чтобы оценить игрока');
      return;
    }
    vw.scrollIntoView({ behavior: 'smooth', block: 'center' });
    vw.classList.remove('rep-vote-pulse'); void vw.offsetWidth; // restart animation
    vw.classList.add('rep-vote-pulse');
    // Pre-highlight the matching category group so it's obvious what to pick
    const group = lean === 'up' ? 'good' : 'bad';
    vw.querySelectorAll(`.rep-btn-${group}`).forEach(b => {
      b.classList.remove('rep-btn-hint'); void b.offsetWidth;
      b.classList.add('rep-btn-hint');
      setTimeout(() => b.classList.remove('rep-btn-hint'), 1600);
    });
  };

  card.appendChild(el('div', { class: 'rep-summary' },
    el('div', { class: `rep-verdict rep-${labelKind}` }, labelText),
    el('div', { class: 'rep-counts' },
      el('button', { class: 'rep-count up', type: 'button', title: 'Оценить положительно',
        onclick: () => jumpToVote('up') }, '👍 ', String(agg.praise || 0)),
      el('button', { class: 'rep-count down', type: 'button', title: 'Оценить отрицательно',
        onclick: () => jumpToVote('down') }, '👎 ', String(agg.reports || 0))
    )
  ));

  // Category breakdown
  const catsWithVotes = REP_CATS.filter(c => (agg.byCat || {})[c.key] > 0);
  if (catsWithVotes.length) {
    const breakdown = el('div', { class: 'rep-breakdown' });
    for (const c of catsWithVotes) {
      breakdown.appendChild(el('div', { class: `rep-bd-item ${c.kind}` },
        el('span', { class: 'rep-bd-emoji' }, c.emoji),
        el('span', { class: 'rep-bd-label' }, c.label),
        el('span', { class: 'rep-bd-count' }, String(agg.byCat[c.key]))
      ));
    }
    card.appendChild(breakdown);
  }

  // Voting controls — multi-select chips + comment + save
  if (me?.logged_in && me.steamid !== steamid) {
    const selected = new Set(agg.my_vote?.categories || []);
    const hasExisting = (agg.my_vote?.categories?.length || 0) > 0 || !!agg.my_vote?.comment;

    const voteWrap = el('div', { class: 'rep-vote' });
    voteWrap.appendChild(el('div', { class: 'rep-vote-h' }, 'Ваша оценка (можно выбрать несколько):'));

    const btns = el('div', { class: 'rep-vote-btns' });
    const chipEls = {};
    for (const c of REP_CATS) {
      const chip = el('button', {
        class: `rep-btn rep-btn-${c.kind}${selected.has(c.key) ? ' active' : ''}`, type: 'button',
        onclick: () => {
          if (selected.has(c.key)) { selected.delete(c.key); chip.classList.remove('active'); }
          else { selected.add(c.key); chip.classList.add('active'); }
        }
      }, c.emoji + ' ' + c.label);
      chipEls[c.key] = chip;
      btns.appendChild(chip);
    }
    voteWrap.appendChild(btns);

    // Comment textarea
    const ta = el('textarea', {
      class: 'rep-comment-input', rows: '2', maxlength: '280',
      placeholder: 'Комментарий (необязательно): что именно произошло…'
    });
    ta.value = agg.my_vote?.comment || '';
    voteWrap.appendChild(ta);
    const counter = el('div', { class: 'rep-comment-counter' }, `${ta.value.length}/280`);
    ta.addEventListener('input', () => { counter.textContent = `${ta.value.length}/280`; });
    voteWrap.appendChild(counter);

    // Action buttons
    const actions = el('div', { class: 'rep-actions' });
    const saveBtn = el('button', { class: 'btn btn-sm rep-save', type: 'button' },
      hasExisting ? 'Обновить оценку' : 'Отправить оценку');
    saveBtn.addEventListener('click', async () => {
      const cats = [...selected];
      if (cats.length === 0 && !ta.value.trim()) {
        toast.warn('Выберите хотя бы одну категорию или напишите комментарий');
        return;
      }
      saveBtn.disabled = true;
      const orig = saveBtn.textContent;
      saveBtn.textContent = 'Сохраняем…';
      try {
        const r = await api.reputation.vote(steamid, cats, ta.value.trim());
        if (r?.ok) {
          paintReputation(steamid, { ok: true, ...r }, me);
          if (r.weight_applied === 0) {
            toast.warn('Оценка учтена, но ваш аккаунт слишком новый — она не влияет на счёт');
          } else {
            toast.ok('Оценка сохранена');
          }
        } else if (r?.error === 'rate-limited') {
          toast.err('Слишком много оценок за час. Попробуйте позже.');
        } else if (r?.error === 'empty-vote') {
          toast.warn('Выберите категорию или напишите комментарий');
        } else {
          toast.err('Не удалось сохранить оценку');
        }
      } catch (_) {
        toast.err('Ошибка сети');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = orig;
      }
    });
    actions.appendChild(saveBtn);

    if (hasExisting) {
      const delBtn = el('button', { class: 'btn btn-sm btn-ghost rep-del', type: 'button' }, 'Убрать');
      delBtn.addEventListener('click', async () => {
        delBtn.disabled = true;
        try {
          const r = await api.reputation.remove(steamid);
          if (r?.ok) {
            paintReputation(steamid, { ok: true, ...r }, me);
            toast.ok('Оценка убрана');
          } else {
            toast.err('Не удалось убрать оценку');
          }
        } catch (_) { toast.err('Ошибка сети'); }
        finally { delBtn.disabled = false; }
      });
      actions.appendChild(delBtn);
    }
    voteWrap.appendChild(actions);
    card.appendChild(voteWrap);
  } else if (!me?.logged_in) {
    card.appendChild(el('div', { class: 'rep-login-hint' },
      'Войдите через Steam, чтобы оценить игрока.'));
  }

  // Comments list
  const comments = agg.comments || [];
  if (comments.length) {
    const cl = el('div', { class: 'rep-comments' });
    cl.appendChild(el('div', { class: 'rep-comments-h' }, `Комментарии (${comments.length})`));
    for (const cm of comments.slice(0, 10)) {
      const chips = (cm.categories || []).map(k => {
        const c = REP_CAT_MAP[k];
        return c ? el('span', { class: `rep-cm-chip ${c.kind}` }, c.emoji + ' ' + c.label) : null;
      }).filter(Boolean);
      cl.appendChild(el('div', { class: 'rep-cm' },
        chips.length ? el('div', { class: 'rep-cm-chips' }, ...chips) : null,
        el('div', { class: 'rep-cm-text' }, cm.comment),
        el('div', { class: 'rep-cm-date' }, cm.updated_at ? shortDate(cm.updated_at) : '')
      ));
    }
    card.appendChild(cl);
  }

  // Caveat
  card.appendChild(el('div', { class: 'rep-note' },
    'Оценки оставляют игроки сообщества. Это субъективные мнения, а не официальные баны Valve.'));

  root.appendChild(card);
}

// Render profile activity feed: user's posts + comments in chronological order
async function paintLookupActivity(steamid) {
  const root = $('#lk-activity');
  if (!root) return;
  root.innerHTML = '';
  const r = await api.request(`/api/profile/${encId(steamid)}/activity`).catch(() => null);
  if (!r?.ok || !r.items?.length) return; // hide block entirely if no activity
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Активность'));
  const list = el('div', { class: 'lk-activity-list' });
  for (const it of r.items) {
    const row = el('a', { class: 'lk-activity-row', href: `/feed?public=${encodeURIComponent(it.public_id)}#post-${it.post_id}` });
    // Icon
    const icon = el('div', { class: 'lk-activity-icon ' + (it.kind === 'post' ? 'is-post' : 'is-comment') },
      it.kind === 'post' ? '📝' : '💬');
    row.appendChild(icon);
    // Body
    const body = el('div', { class: 'lk-activity-body' });
    const head = el('div', { class: 'lk-activity-head' },
      el('span', { class: 'lk-activity-action' }, it.kind === 'post' ? 'Написал пост' : 'Прокомментировал'),
      el('span', { class: 'lk-activity-pub' }, ' в ' + (it.public_name || 'сообществе')),
      el('span', { class: 'lk-activity-date' }, it.created_at ? ' · ' + relDate(it.created_at) : '')
    );
    body.appendChild(head);
    if (it.kind === 'post' && it.title) body.appendChild(el('div', { class: 'lk-activity-title' }, it.title));
    if (it.kind === 'comment' && it.post_title) body.appendChild(el('div', { class: 'lk-activity-context' }, '↳ к посту «' + it.post_title + '»'));
    if (it.body) body.appendChild(el('div', { class: 'lk-activity-text' }, it.body));
    row.appendChild(body);
    list.appendChild(row);
  }
  card.appendChild(list);
  root.appendChild(card);
}

function paintLookupLeetify(leetifyR) {
  const root = $('#lk-leetify');
  if (!root) return;
  root.innerHTML = '';
  // Only render if we actually have data. If not — silently skip; the CSStats/Leetify
  // external link buttons already cover the "go check yourself" case.
  if (!leetifyR?.ok || !leetifyR.data) return;

  const d = leetifyR.data;
  const ranks = d.ranks || {};
  const stats = d.stats || {};
  const numGames = d.total_matches || (d.games || []).length || null;

  const card = el('div', { class: 'card leetify-card' });
  card.appendChild(el('div', { class: 'fc-h' },
    el('div', { class: 'fc-h-left' },
      el('span', { class: 'fc-badge leetify-badge' }, 'LEETIFY'),
      el('span', { style: { color: 'var(--dim)', fontSize: '12px' } },
        'Premier + Faceit · агрегатор матчей')
    ),
    el('a', { class: 'card-link', href: `https://leetify.com/app/profile/${d.steam64Id}`,
      target: '_blank', rel: 'noopener' },
      'Открыть в Leetify ',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })
    )
  ));

  // Pull a few headline numbers if available
  const items = [];
  const num = v => (v == null || v === '' ? null : Number(v));
  // Leetify variant fields — best-effort across schema versions
  const flat = stats || {};
  const rk = ranks || {};
  if (rk.premier?.current ?? rk.premier_cs2 ?? rk.premier_rating)
    items.push({ label: 'Premier CS2', val: String(rk.premier?.current ?? rk.premier_cs2 ?? rk.premier_rating) });
  if (rk.faceit?.current ?? rk.faceit_elo)
    items.push({ label: 'Faceit ELO', val: String(rk.faceit?.current ?? rk.faceit_elo) });
  if (num(flat.totalKills))   items.push({ label: 'Kills',  val: fmtNumber(flat.totalKills) });
  if (num(flat.totalDeaths))  items.push({ label: 'Deaths', val: fmtNumber(flat.totalDeaths) });
  if (num(flat.kd))           items.push({ label: 'K/D',    val: Number(flat.kd).toFixed(2).replace('.', ',') });
  if (num(flat.headshots_percentage)) items.push({ label: 'HS%', val: `${Math.round(flat.headshots_percentage)}%` });
  if (num(flat.average_adr))  items.push({ label: 'ADR',    val: String(Math.round(flat.average_adr)) });
  if (numGames)               items.push({ label: 'Матчей', val: fmtNumber(numGames) });

  if (items.length === 0) {
    // Leetify ответил OK но без полезных полей — просто намекнем что данные есть и линкнем
    card.appendChild(el('div', { class: 'empty-state',
      style: { padding: '24px 18px' } },
      el('div', { class: 'icon' }, '📊'),
      el('div', { class: 'title' }, 'Leetify-профиль найден'),
      el('div', { class: 'desc' }, 'Детальная аналитика доступна на сайте Leetify по кнопке выше.')
    ));
  } else {
    const grid = el('div', { class: 'leetify-stats' });
    for (const it of items.slice(0, 8)) {
      grid.appendChild(el('div', { class: 'lt-stat' },
        el('div', { class: 'lt-stat-label' }, it.label),
        el('div', { class: 'lt-stat-val' }, it.val)
      ));
    }
    card.appendChild(grid);
  }

  // Recent matches list (if Leetify gave them)
  const games = Array.isArray(d.games) ? d.games.slice(0, 8) : [];
  if (games.length) {
    card.appendChild(el('div', { class: 'fc-block-h', style: { marginTop: '14px' } },
      'Последние матчи (Premier + Faceit)'));
    const list = el('div', { class: 'fc-matches-list' });
    for (const g of games) {
      const mapName = g.mapName || g.map_name || g.map || '';
      const look = lookMap(mapName);
      const dateStr = g.gameFinishedAt || g.finished_at || g.matchDate || null;
      const dateFmt = dateStr ? new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      const ourScore = g.teamScores?.[0] ?? g.ownTeamScore ?? null;
      const oppScore = g.teamScores?.[1] ?? g.opponentTeamScore ?? null;
      const won = g.matchResult === 'win' || (ourScore != null && oppScore != null && ourScore > oppScore);
      const source = g.dataSource || g.source || g.matchType || 'CS2';

      list.appendChild(el('a', {
        class: 'fc-match ' + (won ? 'win' : 'loss'),
        href: g.replayUrl || g.matchUrl || `https://leetify.com/app/match-details/${g.id || ''}`,
        target: '_blank', rel: 'noopener'
      },
        el('div', { class: 'fc-match-row1' },
          (function(){const w=mapIconEl(look);w.className='fc-match-map-ico';return w;})(),
          el('div', { class: 'fc-match-info' },
            el('div', { class: 'fc-match-name' }, look.name || mapName || '—'),
            el('div', { class: 'fc-match-meta' }, dateFmt, ' · ',
              el('span', { class: 'lt-source-tag' }, String(source).toUpperCase()))
          ),
          el('div', { class: 'fc-match-score ' + (won ? 'win' : 'loss') },
            el('span', null, ourScore ?? '?'),
            el('span', { class: 'sep' }, ':'),
            el('span', null, oppScore ?? '?')
          ),
          el('div', { class: 'fc-match-result' + (won ? ' win' : ' loss') },
            won ? 'Победа' : 'Поражение')
        )
      ));
    }
    card.appendChild(list);
  }

  root.appendChild(card);
}

function paintLookupProfile(profR, statsR, invR, bansR) {
  const root = $('#lk-profile');
  if (!root) return;
  root.innerHTML = '';
  const p = profR?.profile || {};
  const bans = bansR?.ok ? bansR.data : null;
  const isTelegramProfile = p.source === 'telegram' || /^tg:\d+$/.test(String(p.steamid || ''));

  // Update page title
  if (p.personaname) {
    const t = $('#lk-title');
    if (t) t.textContent = p.personaname;
  }

  const vis = Number(p.communityvisibilitystate || 0);
  const visText = isTelegramProfile ? 'Telegram' : (vis === 3 ? 'Публичный' : vis === 2 ? 'Только друзья' : 'Закрытый');
  const visKind = (isTelegramProfile || vis === 3) ? 'green' : '';
  const sinceYear = p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null;
  const h = statsR?.summary?.headline || {};

  const card = el('div', { class: 'card prof-card' });

  // Cover banner — shown above the profile card if user has set one
  const coverUrl = profR?.cover_url;
  if (coverUrl) {
    const cover = el('div', { class: 'prof-cover' });
    const im = el('img', { src: coverUrl, alt: '', loading: 'lazy' });
    im.onerror = function () { cover.remove(); };
    cover.appendChild(im);
    card.appendChild(cover);
  }

  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Профиль игрока'));

  // Critical bans banner — only when there are bans
  if (bans && (bans.vac_banned || bans.number_of_vac_bans > 0 || bans.number_of_game_bans > 0 || bans.community_banned)) {
    const parts = [];
    if (bans.number_of_vac_bans > 0) parts.push(`VAC × ${bans.number_of_vac_bans}`);
    else if (bans.vac_banned) parts.push('VAC');
    if (bans.number_of_game_bans > 0) parts.push(`Game Ban × ${bans.number_of_game_bans}`);
    if (bans.community_banned) parts.push('Community');
    const days = bans.days_since_last_ban || 0;
    card.appendChild(el('div', { class: 'lk-ban-banner' },
      el('span', { class: 'lb-icon', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' }),
      el('div', null,
        el('div', { class: 'lb-title' }, parts.join(' · ')),
        el('div', { class: 'lb-sub' }, days > 0 ? `Последний бан ${days} ${pluralDays(days)} назад` : 'Активная блокировка')
      )
    ));
  }

  // Avatar + name + steamid
  const top = el('div', { class: 'pc-top' });
  if (p.avatarfull || p.avatar) {
    top.appendChild(el('img', {
      class: 'pc-avatar', src: p.avatarfull || p.avatar, alt: '',
      onerror: function() { this.style.opacity = '0'; }
    }));
  } else {
    top.appendChild(el('div', { class: 'pc-avatar',
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px' } },
      (p.personaname || '?').slice(0, 1).toUpperCase()));
  }
  const info = el('div', { style: { minWidth: 0, flex: 1 } });
  const nameRow = el('div', { class: 'pc-name' }, p.personaname || 'Без имени');
  if (vis === 3) {
    nameRow.appendChild(el('span', { class: 'verified', title: 'Публичный профиль', html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }));
  }
  // Role badge (from presence)
  if (profR?.presence?.role) {
    const rb = roleBadge(profR.presence.role);
    if (rb) nameRow.appendChild(rb);
  }
  info.appendChild(nameRow);
  info.appendChild(el('div', { class: 'pc-sub' },
    `${isTelegramProfile ? 'Telegram ID' : 'Steam ID'}: ${p.steamid || '—'}`,
    el('button', { type: 'button', title: 'Скопировать',
      onclick: () => { try { navigator.clipboard.writeText(p.steamid || ''); toast.ok(isTelegramProfile ? 'Telegram ID скопирован' : 'SteamID скопирован'); } catch (_) {} }
    }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }))
  ));
  // Presence row: in-site activity + Steam in-game (respects target's privacy)
  const presence = profR?.presence;
  const presLbl = presenceLabel(presence);
  if (presLbl) {
    const state = presenceState(presence);
    info.appendChild(el('div', { class: 'pc-presence pc-presence-' + state },
      el('span', { class: 'presence-dot presence-' + state }),
      presLbl
    ));
  }
  top.appendChild(info);
  card.appendChild(top);

  // Badges
  const badges = el('div', { class: 'pc-badges' });
  badges.appendChild(el('span', { class: 'pill ' + (visKind === 'green' ? 'green' : '') },
    el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>' }),
    visText
  ));
  if (sinceYear) {
    badges.appendChild(el('span', { class: 'pill' },
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' }),
      `с ${sinceYear}`
    ));
  }
  if (p.loccountrycode || p.countrycode) {
    badges.appendChild(el('span', { class: 'pill' },
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>' }),
      p.loccountrycode || p.countrycode
    ));
  }
  card.appendChild(badges);

  // Mini stats (3-up): K/D, HS%, Matches OR Winrate
  card.appendChild(el('div', { class: 'pc-stats' },
    el('div', { class: 'pc-stat' },
      el('div', { class: 'lbl', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>K/D' }),
      el('div', { class: 'val' }, h.kd != null ? h.kd.toFixed(2).replace('.', ',') : '—'),
      el('div', { class: 'desc' + (h.kd == null ? ' dim' : '') }, h.kd == null ? 'нет данных' : (rateKd(h.kd)?.text || ''))
    ),
    el('div', { class: 'pc-stat' },
      el('div', { class: 'lbl', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>HS%' }),
      el('div', { class: 'val' }, h.hsRate != null ? `${h.hsRate.toFixed(1)}%` : '—'),
      el('div', { class: 'desc' + (h.hsRate == null ? ' dim' : '') }, h.hsRate == null ? 'нет данных' : (rateHs(h.hsRate)?.text || ''))
    ),
    el('div', { class: 'pc-stat' },
      el('div', { class: 'lbl', html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>Матчей' }),
      el('div', { class: 'val' }, h.matches != null ? fmtNumber(h.matches) : '—'),
      el('div', { class: 'desc dim' }, 'Всего')
    )
  ));

  root.appendChild(card);

  // Below the profile card: external profile links — Steam, CSStats, Leetify, Faceit
  // CSStats and Leetify accept SteamID64 directly; Faceit needs faceit_url from API response.
  const sid = p.steamid;
  if (sid && !isTelegramProfile) {
    const links = el('div', { class: 'card ext-links' });
    links.appendChild(el('div', { class: 'card-eyebrow' }, 'Другие сервисы'));
    links.appendChild(el('div', { class: 'ext-links-grid' },
      p.profileurl ? buildExtLink({
        href: p.profileurl, label: 'Steam', tag: 'Профиль',
        color: '#5293cf'
      }) : null,
      buildExtLink({
        href: `https://csstats.gg/player/${sid}`,
        label: 'CSStats', tag: 'Per-match',
        color: '#ff6a55'
      }),
      buildExtLink({
        href: `https://leetify.com/app/profile/${sid}`,
        label: 'Leetify', tag: 'Анализ',
        color: '#a78bfa'
      })
    ));
    root.appendChild(links);
  }
}

function buildExtLink({ href, label, tag, color }) {
  return el('a', {
    class: 'ext-link', href, target: '_blank', rel: 'noopener'
  },
    el('div', { class: 'ext-link-body' },
      el('div', { class: 'ext-link-label', style: { color: color || 'var(--text)' } }, label),
      el('div', { class: 'ext-link-tag' }, tag)
    ),
    el('span', { class: 'ext-link-arrow', html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>' })
  );
}

function paintLookupInvKpis(invR, histR) {
  const root = $('#lk-inv-kpis');
  if (!root) return;
  root.innerHTML = '';
  if (!invR?.ok) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-eyebrow' }, 'Инвентарь'),
      el('div', { class: 'empty-state' },
        el('div', { class: 'icon' }, '📦'),
        el('div', { class: 'title' }, 'Инвентарь недоступен'),
        el('div', { class: 'desc' }, invStatusReason(invR?.status, invR?.http_status))
      )
    ));
    return;
  }
  // 3-up KPI strip: total value | items / priced | unique names
  const totalVal = invR.total_value_text || (invR.total_value != null ? fmtPrice(invR.total_value, invR.currency) : '—');
  const priced = invR.pricing?.priced_items || 0;
  const total = (priced + (invR.pricing?.unpriced_items || 0)) || invR.total_items || 0;
  const unique = invR.pricing?.unique_names || 0;
  const inventoryLink = `/inventory?steamid=${invR.steamid}`;

  const wrap = el('div', { class: 'card', style: { padding: '20px 22px' } });
  wrap.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' } },
    el('div', { class: 'card-eyebrow', style: { marginBottom: 0 } }, 'Инвентарь'),
    el('a', { href: inventoryLink, class: 'card-link' },
      'Открыть полностью',
      el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' })
    )
  ));
  wrap.appendChild(el('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
    miniKpiBlock('Общая стоимость', totalVal, priced > 0 ? `${priced} оценено в ${invR.currency}` : 'нет цен'),
    miniKpiBlock('Предметов', `${total}`, `${priced} с ценой · ${total - priced} без`),
    miniKpiBlock('Уникальных моделей', `${unique}`, 'market_hash_name')
  ));
  root.appendChild(wrap);
}

function miniKpiBlock(label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'card-eyebrow', style: { marginBottom: '8px' } }, label),
    el('div', { class: 'kpi-val', style: { fontSize: '24px' } }, value),
    el('div', { class: 'kpi-sub dim',
      style: { textTransform: 'none', fontSize: '11px', color: 'var(--dim)', fontWeight: 500, letterSpacing: 0 } },
      sub)
  );
}

function paintLookupStatsKpis(statsR) {
  const root = $('#lk-stats-kpis');
  if (!root) return;
  root.innerHTML = '';

  const reason = statsUnavailableReason(statsR);
  if (reason) {
    root.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-eyebrow' }, 'Статистика CS2'),
      el('div', { class: 'empty-state' },
        el('div', { class: 'icon' }, '📊'),
        el('div', { class: 'title' }, 'Статистика недоступна'),
        el('div', { class: 'desc' }, reason)
      )
    ));
    return;
  }
  const h = statsR.summary.headline;
  const wrap = el('div', { class: 'card', style: { padding: '20px 22px' } });
  wrap.appendChild(el('div', { class: 'card-eyebrow', style: { marginBottom: '14px' } }, 'Статистика CS2'));
  wrap.appendChild(el('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(4, 1fr)' } },
    buildKpiCard({ name: 'K/D', val: h.kd != null ? h.kd.toFixed(2).replace('.', ',') : '—', tag: rateKd(h.kd), icon: 'kd' }),
    buildKpiCard({ name: 'HS%', val: h.hsRate != null ? fmtPct(h.hsRate, 1) : '—', tag: rateHs(h.hsRate), icon: 'crosshair' }),
    buildKpiCard({ name: 'Точность', val: h.accuracy != null ? fmtPct(h.accuracy, 1) : '—', tag: rateAcc(h.accuracy), icon: 'target' }),
    buildKpiCard({ name: 'Часов', val: h.hours != null ? fmtNumber(h.hours, 0) : '—', tag: { text: 'CS2', kind: 'dim' }, icon: 'grid' })
  ));
  root.appendChild(wrap);
}

function paintLookupTables(statsR) {
  const root = $('#lk-tables');
  if (!root) return;
  root.innerHTML = '';

  const maps = (statsR?.summary?.maps || []).slice(0, 6);
  const weapons = (statsR?.summary?.weapons || []).slice(0, 6);

  // Maps card
  if (maps.length === 0) {
    root.appendChild(emptyCard('Карты',
      'Когда статистика CS2 будет доступна, здесь появятся винрейт и матчи по картам.', '🗺️'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' }, el('h2', null, 'Карты')));
    const tbl = el('div', { class: 'tbl tbl-maps' });
    tbl.appendChild(el('div', { class: 'tbl-head' },
      el('div', null, 'Карта'), el('div', null, 'Раунды'), el('div', null, 'Winrate'), el('div', null, 'Победы')));
    for (const m of maps) {
      const look = lookMap(m.map);
      const wr = m.winrate != null ? m.winrate : 0;
      tbl.appendChild(el('div', { class: 'tbl-row' },
        el('div', { class: 'map-cell' },
          mapIconEl(look),
          el('div', { class: 'map-name' }, look.name)
        ),
        el('div', null, fmtNumber(m.rounds)),
        el('div', { class: 'winrate-cell' },
          el('div', { class: 'winrate-bar' },
            el('div', { class: 'winrate-fill', style: { width: `${Math.min(100, Math.max(0, wr))}%` } })
          ),
          el('span', null, m.winrate != null ? `${m.winrate.toFixed(0)}%` : '—')
        ),
        el('div', null, fmtNumber(m.wins))
      ));
    }
    card.appendChild(tbl);
    root.appendChild(card);
  }

  // Weapons card
  if (weapons.length === 0) {
    root.appendChild(emptyCard('Оружие',
      'Сюда попадут убийства, точность и предпочтения по оружию.', '🔫'));
  } else {
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-h' }, el('h2', null, 'Оружие')));
    const tbl = el('div', { class: 'tbl tbl-weapons' });
    tbl.appendChild(el('div', { class: 'tbl-head' },
      el('div', null, 'Оружие'), el('div', null, 'Убийства'), el('div', null, 'Выстрелы'), el('div', null, 'Точность')));
    for (const w of weapons) {
      const look = lookWeapon(w.weapon);
      tbl.appendChild(el('div', { class: 'tbl-row' },
        el('div', { class: 'w-cell' },
          weaponIconEl(look),
          el('div', { class: 'w-name' }, look.name)
        ),
        el('div', null, fmtNumber(w.kills)),
        el('div', null, fmtNumber(w.shots)),
        el('div', null, w.accuracy != null ? `${w.accuracy.toFixed(1)}%` : '—')
      ));
    }
    card.appendChild(tbl);
    root.appendChild(card);
  }
}

function paintLookupTopItems(invR) {
  const root = $('#lk-top');
  if (!root) return;
  root.innerHTML = '';

  if (!invR?.ok) return;  // already shown in invKpis empty state

  const top = (invR.items || [])
    .filter(i => i.price_value != null)
    .sort((a, b) => b.price_value - a.price_value)
    .slice(0, 5);
  if (top.length === 0) return;  // nothing to show

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Топ предметов'));
  const list = el('div', { class: 'movers-list' });
  top.forEach((it, i) => list.appendChild(buildMoverRow(i + 1, it, invR.currency)));
  card.appendChild(list);
  root.appendChild(card);
}


// ============ page: feed ============
async function pageFeed() {
  const me = await renderTopbar('feed');
  if (!me.logged_in) {
    toast.warn('Войдите через Steam, чтобы открыть ленту');
    setTimeout(() => location.replace('/'), 800);
    return;
  }

  // Single public view?
  const publicId = new URLSearchParams(location.search).get('public');
  if (publicId) {
    await renderPublicPage(publicId, me);
    // Still show sidebar publics
    try { paintFeedSide(await api.publics()); } catch (_) {}
    return;
  }

  const state = { scope: 'all' };

  // Scope tabs
  const tabs = $('#feed-tabs');
  if (tabs) {
    for (const btn of tabs.querySelectorAll('.feed-tab')) {
      btn.addEventListener('click', () => {
        for (const b of tabs.querySelectorAll('.feed-tab')) b.classList.remove('active');
        btn.classList.add('active');
        state.scope = btn.dataset.scope;
        loadFeed();
      });
    }
  }

  const loadFeed = async () => {
    const list = $('#feed-list');
    if (list) list.innerHTML = '<div class="card"><div class="loading-inline"><div class="spinner sm"></div>Загружаем ленту…</div></div>';
    try {
      const r = await api.feed(state.scope);
      paintFeedList(r);
    } catch (_) {
      paintFeedList({ ok: false, items: [] });
    }
  };

  await loadFeed();
  // Sidebar with publics
  try {
    const p = await api.publics();
    paintFeedSide(p);
  } catch (_) {
    paintFeedSide({ ok: false, publics: [] });
  }
}

// Single public page: header + posts, with owner controls
async function renderPublicPage(publicId, me) {
  const head = document.querySelector('.feed-head'); if (head) head.style.display = 'none';
  const list = $('#feed-list');
  list.innerHTML = '<div class="card"><div class="loading-inline"><div class="spinner sm"></div>Загрузка…</div></div>';

  const r = await api.publicDetail(publicId).catch(() => ({ ok: false }));
  if (!r.ok) { list.innerHTML = ''; list.appendChild(emptyCard('Паблик не найден', 'Возможно, он был удалён.', '🔍')); return; }
  const p = r.public;
  list.innerHTML = '';

  // Cover banner (if set)
  if (p.cover) {
    list.appendChild(el('div', { class: 'pub-cover' },
      el('img', { src: p.cover, alt: '' })));
  }

  // Header card
  const header = el('div', { class: 'card pub-header' + (p.cover ? ' has-cover' : '') },
    el('div', { class: 'pub-header-top' },
      el('div', { class: 'feed-pub-avatar lg' + (p.verified ? ' official' : '') },
        p.avatar ? el('img', { src: p.avatar, alt: '' }) : (p.name || '?').slice(0, 1).toUpperCase()),
      el('div', { class: 'pub-header-info' },
        el('div', { class: 'pub-header-name' }, p.name,
          p.verified ? el('span', { class: 'feed-verified', title: 'Проверено', html:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }) : null),
        p.description ? el('div', { class: 'pub-header-desc' }, p.description) : null
      )
    ),
    el('div', { class: 'pub-header-actions' },
      p.can_post
        ? el('button', { class: 'btn', type: 'button', onclick: () => openCreatePostModal(p) }, 'Новый пост')
        : el('button', { class: 'btn' + (p.subscribed ? ' btn-ghost' : ''), type: 'button',
            onclick: async (e) => {
              const btn = e.currentTarget; btn.disabled = true;
              const res = p.subscribed ? await api.unsubscribePublic(p.id) : await api.subscribePublic(p.id);
              if (res?.ok) { p.subscribed = res.subscribed; btn.textContent = p.subscribed ? 'Отписаться' : 'Подписаться'; btn.classList.toggle('btn-ghost', p.subscribed); }
              btn.disabled = false;
            } }, p.subscribed ? 'Отписаться' : 'Подписаться'),
      p.is_owner ? el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => openPublicStatsModal(p) }, 'Статистика') : null,
      p.is_owner ? el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => openEditPublicModal(p, () => renderPublicPage(publicId, me)) }, 'Редактировать') : null,
      p.is_owner ? el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: () => openEditorsModal(p) }, 'Редакторы') : null,
      p.is_owner ? el('button', { class: 'btn btn-ghost', type: 'button',
        onclick: async () => { if (confirm('Удалить паблик со всеми постами?')) { await api.deletePublic(p.id); toast.ok('Удалён'); location.href = '/feed'; } } }, 'Удалить паблик') : null
    )
  );
  list.appendChild(header);

  // Posts
  if (!r.posts?.length) {
    list.appendChild(emptyCard('Пока нет постов',
      p.is_owner ? 'Опубликуйте первый пост: новость, набор в пати, полезную ссылку или обновление сообщества.' : 'Здесь пока пусто. Подпишитесь на другие сообщества или вернитесь в общую ленту.',
      '📝',
      p.is_owner
        ? [
            { label: 'Написать пост', onclick: () => openCreatePostModal(p) },
            { label: 'Редактировать паблик', class: 'btn btn-sm btn-ghost', onclick: () => openEditPublicModal(p, () => renderPublicPage(publicId, me)) }
          ]
        : [
            { label: 'К ленте', href: '/feed' },
            { label: 'Сообщества', class: 'btn btn-sm btn-ghost', href: '/communities' }
          ]));
    return;
  }
  for (const post of r.posts) {
    const card = el('div', { class: 'feed-item card' });
    card.appendChild(el('div', { class: 'feed-item-h' },
      el('div', { class: 'feed-pub' },
        el('div', { class: 'feed-pub-avatar' + (p.verified ? ' official' : '') },
          p.avatar ? el('img', { src: p.avatar, alt: '' }) : (p.name || '?').slice(0, 1).toUpperCase()),
        el('div', null,
          el('div', { class: 'feed-pub-name' }, p.name),
          el('div', { class: 'feed-date' }, post.created_at ? relDate(post.created_at) : '')
        )
      ),
      (function () {
        const canEdit = me?.steamid && post.author_steam_id === me.steamid;
        const canDelete = p.is_owner || me.is_admin || canEdit;
        const canPin = p.is_owner || me.is_admin;
        if (!canEdit && !canDelete && !canPin) return null;
        const actions = el('div', { class: 'feed-actions' });
        if (canPin) {
          const isPinned = !!post.pinned_at;
          actions.appendChild(el('button', {
            class: 'feed-pin' + (isPinned ? ' pinned' : ''), type: 'button',
            title: isPinned ? 'Открепить' : 'Закрепить наверху',
            onclick: async () => {
              const r = isPinned ? await api.unpinPost(post.id) : await api.pinPost(post.id);
              if (r.ok) { toast.ok(isPinned ? 'Откреплено' : 'Закреплено'); renderPublicPage(publicId, me); }
              else toast.err('Не удалось');
            },
            html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="' + (isPinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.7-2.5a2 2 0 0 1-.3-1V7H7v6.5a2 2 0 0 1-.3 1L5 17z"/></svg>'
          }));
        }
        if (canEdit) {
          actions.appendChild(el('button', { class: 'feed-edit', type: 'button', title: 'Редактировать',
            onclick: () => openCreatePostModal({ id: post.public_id, name: p.name }, {
              post_id: post.id, title: post.title, body: post.body, link: post.link,
              image: post.image, images: post.images, poll: post.poll
            }),
            html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' }));
        }
        if (canDelete) {
          actions.appendChild(el('button', { class: 'feed-del', type: 'button', title: 'Удалить',
            onclick: async () => { if (confirm('Удалить пост?')) { await api.deletePost(post.id); toast.ok('Удалён'); renderPublicPage(publicId, me); } },
            html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }));
        }
        return actions;
      })()
    ));
    // "Pinned" badge above the title for pinned posts
    if (post.pinned_at) card.appendChild(el('div', { class: 'feed-pinned-tag' }, '📌 Закреплено'));
    if (post.title) card.appendChild(el('div', { class: 'feed-item-title' }, post.title));
    const imgsNode = buildPostImages(post);
    if (imgsNode) card.appendChild(imgsNode);
    if (post.body) { const b = buildPostBody(post.body, false); if (b) card.appendChild(b); }
    if (post.poll) card.appendChild(buildPollCard(post.id, post.poll, me));
    if (post.edited_at) card.appendChild(el('div', { class: 'feed-edited' }, '✎ изменено'));
    if (post.link) card.appendChild(el('a', { class: 'feed-item-link', href: post.link, target: '_blank', rel: 'noopener' }, 'Перейти по ссылке →'));
    const pf = buildPostFooter({ post_id: post.id, public_id: post.public_id, likes: post.likes, views: post.views, comments: post.comments, liked: post.liked }, me);
    if (pf) card.appendChild(pf);
    markPostViewed(post.id);
    list.appendChild(card);
  }
}

// Render one or multiple post images. Single image full-width; multiple → grid.
function buildPostImages(item) {
  const arr = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
  if (!arr.length) return null;
  if (arr.length === 1) {
    const img = el('img', { class: 'feed-item-img', src: arr[0], alt: '', loading: 'lazy' });
    img.onerror = function () { this.remove(); };
    return img;
  }
  // Multi-image grid (2 — side-by-side; 3 — 2+1; 4+ — 2-column grid)
  const grid = el('div', { class: 'feed-img-grid feed-img-grid-' + Math.min(arr.length, 4) });
  arr.slice(0, 6).forEach((src, i) => {
    const cell = el('div', { class: 'feed-img-cell' });
    const img = el('img', { src, alt: '', loading: 'lazy' });
    img.onerror = function () { cell.remove(); };
    cell.appendChild(img);
    if (i === 5 && arr.length > 6) {
      cell.appendChild(el('div', { class: 'feed-img-more' }, '+' + (arr.length - 6)));
    }
    grid.appendChild(cell);
  });
  return grid;
}

// Render a poll attached to a post — shows percentages, lets user vote (single choice)
function buildPollCard(postId, poll, me) {
  if (!poll || !Array.isArray(poll.options)) return null;
  const card = el('div', { class: 'poll-card' });
  if (poll.question) card.appendChild(el('div', { class: 'poll-question' }, poll.question));
  const foot = el('div', { class: 'poll-foot' });
  const render = (data) => {
    card.querySelectorAll('.poll-option').forEach(n => n.remove());
    const totalV = data.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
    let myV = -1;
    if (me?.steamid) data.options.forEach((o, i) => { if ((o.votes || []).includes(me.steamid)) myV = i; });
    data.options.forEach((o, i) => {
      const count = o.votes?.length || 0;
      const pct = totalV ? Math.round(count * 100 / totalV) : 0;
      const row = el('button', { class: 'poll-option' + (myV === i ? ' voted' : ''), type: 'button',
        onclick: async () => {
          if (!me?.logged_in) { toast.warn('Войдите чтобы голосовать'); return; }
          const r = await api.votePoll(postId, i).catch(() => ({ ok: false }));
          if (r.ok && r.poll) render(r.poll);
        }
      },
        el('div', { class: 'poll-option-fill', style: { width: pct + '%' } }),
        el('div', { class: 'poll-option-content' },
          el('span', { class: 'poll-option-text' }, o.text),
          el('span', { class: 'poll-option-pct' }, totalV ? (pct + '% · ' + count) : '0')
        )
      );
      card.insertBefore(row, foot);
    });
    foot.textContent = totalV
      ? `${totalV} ${plural(totalV, ['голос', 'голоса', 'голосов'])}` + (myV >= 0 ? ' · вы проголосовали' : '')
      : 'Будьте первым кто проголосует';
  };
  card.appendChild(foot);
  render(poll);
  return card;
}

// Build a post-body node with VK/Telegram-style "show more" for long content.
// `clean` controls stripping (true = run stripFeedHtml, for news bodies).
function buildPostBody(text, clean) {
  const raw = String(text || '');
  if (!raw) return null;
  const display = clean ? stripFeedHtml(raw) : raw;
  const long = display.length > 1400 || (display.match(/\n/g) || []).length > 20;
  const body = el('div', { class: 'feed-item-body' + (long ? ' collapsed' : '') }, display);
  if (!long) return body;
  const wrap = el('div');
  wrap.appendChild(body);
  const btn = el('button', { class: 'feed-item-expand', type: 'button' }, 'Показать полностью');
  btn.addEventListener('click', () => {
    const open = body.classList.toggle('collapsed') === false;
    btn.textContent = open ? 'Свернуть' : 'Показать полностью';
  });
  // Initially collapsed → button says "Показать полностью"
  wrap.appendChild(btn);
  return wrap;
}

// Post footer: like, comments, share + counters.
function buildPostFooter(item, me) {
  if (!item || item.post_id == null) return null;
  const likes = item.likes || 0;
  const views = item.views || 0;
  const commentsCount = item.comments || 0;
  const liked = !!item.liked;

  // Like button
  const heart = el('button', {
    class: 'post-act' + (liked ? ' liked' : ''), type: 'button',
    'aria-label': liked ? 'Убрать лайк' : 'Лайкнуть',
    html: `<svg viewBox="0 0 24 24" width="17" height="17" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span class="post-act-n">${likes}</span>`
  });
  // Like button — state in variable, optimistic update for instant feedback
  let isLiked = !!liked;
  let likeCount = likes;
  const renderHeart = () => {
    heart.classList.toggle('liked', isLiked);
    heart.querySelector('.post-act-n').textContent = likeCount;
    const svg = heart.querySelector('svg');
    if (svg) svg.setAttribute('fill', isLiked ? 'currentColor' : 'none');
  };
  heart.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!me?.logged_in) { toast.warn('Войдите, чтобы лайкать'); return; }
    // Optimistic flip — instant UI response
    const wasLiked = isLiked;
    isLiked = !isLiked;
    likeCount += isLiked ? 1 : -1;
    renderHeart();
    heart.disabled = true;
    const r = await (wasLiked ? api.unlikePost(item.post_id) : api.likePost(item.post_id)).catch(() => ({ ok: false }));
    if (r.ok) {
      // Reconcile with server count
      if (typeof r.likes === 'number') { likeCount = r.likes; renderHeart(); }
    } else {
      // Revert on failure
      isLiked = wasLiked; likeCount += wasLiked ? 1 : -1; renderHeart();
      toast.err('Не удалось');
    }
    heart.disabled = false;
  });

  // Comment toggle
  const commentBtn = el('button', {
    class: 'post-act', type: 'button', 'aria-label': 'Комментарии',
    html: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg><span class="post-act-n">${commentsCount}</span>`
  });

  // Share
  const shareBtn = el('button', {
    class: 'post-act', type: 'button', 'aria-label': 'Поделиться',
    html: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>'
  });
  shareBtn.addEventListener('click', (e) => { e.stopPropagation(); openShareModal(item, me); });

  // Views
  const eye = el('span', { class: 'post-act post-views', title: 'Уникальные просмотры',
    html: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span class="post-act-n">${views}</span>`
  });

  const footer = el('div', { class: 'post-footer' }, heart, commentBtn, shareBtn, eye);

  // Two panels: a compact preview (always visible if comments exist) and a full panel (toggled)
  const preview = el('div', { class: 'comments-preview', style: { display: 'none' } });
  const panel = el('div', { class: 'comments-panel', style: { display: 'none' } });

  // Auto-load preview if there are any comments. Don't show spinner — silently fill.
  const loadPreview = async () => {
    if (!item.comments || item.comments < 1) { preview.style.display = 'none'; return; }
    const r = await api.listComments(item.post_id).catch(() => ({ ok: false, comments: [] }));
    if (!r.ok || !r.comments?.length) { preview.style.display = 'none'; return; }
    // Also fix stale count from cached feed payload
    commentBtn.querySelector('.post-act-n').textContent = r.comments.length;
    renderCommentsPreview(preview, r.comments, item.post_id, me, () => {
      // After user expands → switch to full panel
      preview.style.display = 'none';
      panel.style.display = '';
      loadCommentsInto(panel, item.post_id, me, () => {
        const n = panel.querySelectorAll('.comment-row').length;
        commentBtn.querySelector('.post-act-n').textContent = n;
      });
    });
    preview.style.display = '';
  };
  // Defer load to avoid spamming /api/posts/N/comments for every post at once
  // Defer load to avoid spamming /api/posts/N/comments for every post at once.
  // Safari iOS doesn't have requestIdleCallback — accessing it as a bare name
  // throws ReferenceError, so we must check via window.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(loadPreview, { timeout: 1500 });
  } else {
    setTimeout(loadPreview, 300);
  }

  commentBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // If full panel is open → close it (back to preview)
    if (panel.style.display !== 'none') {
      panel.style.display = 'none';
      loadPreview();
      return;
    }
    // Otherwise → open full panel
    preview.style.display = 'none';
    panel.style.display = '';
    await loadCommentsInto(panel, item.post_id, me, () => {
      const n = panel.querySelectorAll('.comment-row').length;
      commentBtn.querySelector('.post-act-n').textContent = n;
    });
  });

  const wrap = el('div');
  wrap.appendChild(footer);
  wrap.appendChild(preview);
  wrap.appendChild(panel);
  return wrap;
}

// Render compact preview: last 3 comments + "Show all N" link.
// Tapping the link triggers `onExpand()` to swap into full panel.
function renderCommentsPreview(container, comments, postId, me, onExpand) {
  container.innerHTML = '';
  const total = comments.length;
  const last3 = comments.slice(-3); // chronological, last 3
  if (total > 3) {
    container.appendChild(el('button', { class: 'comments-show-all', type: 'button',
      onclick: (e) => { e.stopPropagation(); onExpand(); } },
      `Показать все ${total} ` + plural(total, ['комментарий', 'комментария', 'комментариев'])));
  }
  for (const c of last3) {
    const ava = el('div', { class: 'comment-ava' });
    if (c.author_avatar) {
      const img = el('img', { src: c.author_avatar, alt: '' });
      img.onerror = function () { this.remove(); ava.textContent = (c.author_name || '?').slice(0, 1).toUpperCase(); };
      ava.appendChild(img);
    } else ava.textContent = (c.author_name || '?').slice(0, 1).toUpperCase();
    container.appendChild(el('div', { class: 'comment-row' },
      ava,
      el('div', { class: 'comment-body' },
        el('div', { class: 'comment-head' },
          el('a', { class: 'comment-name', href: `/lookup?steamid=${encId(c.author_steam_id)}` }, c.author_name || c.author_steam_id),
          roleBadge(c.author_role),
          el('span', { class: 'comment-date' }, c.created_at ? relDate(c.created_at) : '')
        ),
        el('div', { class: 'comment-text' }, c.body)
      )
    ));
  }
  // "Write a comment" link to expand full panel
  if (me?.logged_in) {
    container.appendChild(el('button', { class: 'comments-write-link', type: 'button',
      onclick: (e) => { e.stopPropagation(); onExpand(); } }, 'Написать комментарий…'));
  }
}

async function loadCommentsInto(panel, postId, me, onChange) {
  panel.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Загрузка…</div>';
  const r = await api.listComments(postId).catch(() => ({ ok: false, comments: [] }));
  const list = el('div', { class: 'comments-list' });
  const renderOne = (c) => {
    const ava = el('div', { class: 'comment-ava' });
    if (c.author_avatar) {
      const img = el('img', { src: c.author_avatar, alt: '' });
      img.onerror = function() { this.remove(); ava.textContent = (c.author_name || '?').slice(0,1).toUpperCase(); };
      ava.appendChild(img);
    } else ava.textContent = (c.author_name || '?').slice(0,1).toUpperCase();
    const canDelete = me?.logged_in && (c.author_steam_id === me.steamid || me.is_admin);
    return el('div', { class: 'comment-row', 'data-cid': String(c.id) },
      ava,
      el('div', { class: 'comment-body' },
        el('div', { class: 'comment-head' },
          el('a', { class: 'comment-name', href: `/lookup?steamid=${encId(c.author_steam_id)}` }, c.author_name || c.author_steam_id),
          roleBadge(c.author_role),
          el('span', { class: 'comment-date' }, c.created_at ? relDate(c.created_at) : '')
        ),
        el('div', { class: 'comment-text' }, c.body),
        canDelete ? el('button', { class: 'comment-del', type: 'button',
          onclick: async () => { if (!confirm('Удалить комментарий?')) return;
            const res = await api.deleteComment(postId, c.id);
            if (res.ok) { const row = list.querySelector(`[data-cid="${c.id}"]`); if (row) row.remove(); onChange && onChange(); }
          }, html: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>' }) : null
      )
    );
  };
  for (const c of (r.comments || [])) list.appendChild(renderOne(c));
  if (!r.comments?.length) list.appendChild(el('div', { class: 'comments-empty' }, 'Пока нет комментариев. Будьте первым!'));

  panel.innerHTML = '';
  panel.appendChild(list);

  if (me?.logged_in) {
    const input = el('textarea', { class: 'comment-input', rows: '1', placeholder: 'Написать комментарий…', maxlength: '1000' });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
    const sendBtn = el('button', { class: 'btn btn-sm comment-send', type: 'button',
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      const res = await api.addComment(postId, text).catch(() => ({ ok: false }));
      sendBtn.disabled = false;
      if (res.ok && res.comment) {
        input.value = ''; input.style.height = 'auto';
        // Remove empty placeholder if present
        const emptyEl = list.querySelector('.comments-empty'); if (emptyEl) emptyEl.remove();
        list.appendChild(renderOne(res.comment));
        onChange && onChange();
      } else {
        toast.err(res.error === 'banned' ? 'Вы заблокированы' : 'Не отправлено');
      }
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    panel.appendChild(el('div', { class: 'comment-form' }, input, sendBtn));
  } else {
    panel.appendChild(el('div', { class: 'comments-empty' }, 'Войдите, чтобы оставить комментарий.'));
  }
}

// Share to a friend in DM (post link)
async function openShareModal(item, me) {
  if (!me?.logged_in) { toast.warn('Войдите, чтобы поделиться'); return; }
  const link = `${location.origin}/feed?public=${encodeURIComponent(item.public_id)}#post-${item.post_id}`;
  const listBox = el('div', { class: 'share-list' });
  listBox.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Друзья…</div>';

  openModal('Поделиться постом', [
    el('div', { class: 'modal-hint' }, 'Отправьте пост другу в личные сообщения.'),
    listBox,
    el('label', { class: 'modal-label' }, 'Или скопируйте ссылку'),
    el('div', { class: 'share-link-row' },
      el('input', { class: 'modal-input', readonly: 'readonly', value: link }),
      el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(link); track('profile_shared', { target: steamid }); toast.ok('Скопировано'); }
        catch (_) { toast.warn('Скопируйте вручную'); }
      } }, 'Копировать')
    )
  ], async () => true, 'Закрыть');

  const r = await api.friends().catch(() => ({ ok: false, friends: [] }));
  listBox.innerHTML = '';
  const friends = r.friends || [];
  if (!friends.length) {
    listBox.appendChild(el('div', { class: 'share-empty' }, 'У вас пока нет друзей на сайте. Добавьте кого-нибудь, чтобы делиться.'));
    return;
  }
  for (const f of friends) {
    const row = el('button', { class: 'share-row', type: 'button' });
    const ava = el('div', { class: 'share-ava' });
    if (f.avatar) {
      const img = el('img', { src: f.avatar, alt: '' });
      img.onerror = function() { this.remove(); ava.textContent = (f.name || '?').slice(0,1).toUpperCase(); };
      ava.appendChild(img);
    } else ava.textContent = (f.name || '?').slice(0,1).toUpperCase();
    row.appendChild(ava);
    row.appendChild(el('div', { class: 'share-name' }, f.name));
    const sendBtn = el('span', { class: 'share-send-tag' }, 'Отправить');
    row.appendChild(sendBtn);
    row.addEventListener('click', async () => {
      row.disabled = true; sendBtn.textContent = '…';
      const res = await api.sendMessage(f.steam_id, '', { type: 'post', post_id: item.post_id }).catch(() => ({ ok: false }));
      if (res.ok) { track('profile_shared', { target: steamid }); sendBtn.textContent = 'Отправлено ✓'; sendBtn.classList.add('sent'); }
      else { sendBtn.textContent = 'Ошибка'; row.disabled = false; }
    });
    listBox.appendChild(row);
  }
}

// Mark a post as viewed (best-effort; backend dedupes per user)
const _viewed = new Set();
function markPostViewed(postId) {
  if (!postId || _viewed.has(postId)) return;
  _viewed.add(postId);
  api.viewPost(postId).catch(() => {});
}

// Empty state card for the feed — with action buttons depending on scope.
function buildFeedEmpty(scope) {
  const card = el('div', { class: 'card feed-empty' });
  let icon = '📰', title = 'Лента пуста', desc = '', cta = null;

  if (scope === 'subs') {
    icon = '👥';
    title = 'Вы пока ни на кого не подписаны';
    desc = 'Подпишитесь на сообщества, чтобы видеть их посты в этой вкладке. Или загляните во вкладку «Все» — там новости CS2 и посты сообществ.';
    cta = el('div', { class: 'feed-empty-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => {
        const allTab = document.querySelector('.feed-tab[data-scope="all"]');
        if (allTab) allTab.click();
      } }, 'Открыть «Все»'),
      el('a', { class: 'btn btn-ghost', href: '/communities' }, 'К сообществам')
    );
  } else if (scope === 'hot') {
    icon = '🔥';
    title = 'В «Горячем» пусто';
    desc = 'Здесь появятся самые обсуждаемые посты за последние 7 дней — те, у которых много лайков, комментариев и просмотров. Создайте интересный пост чтобы попасть в подборку.';
    cta = el('div', { class: 'feed-empty-actions' },
      el('a', { class: 'btn', href: '/communities' }, 'К сообществам')
    );
  } else if (scope === 'official') {
    icon = '🎮';
    title = 'Официальных новостей пока нет';
    desc = 'Когда Valve опубликует новости CS2, они появятся здесь.';
  } else {
    icon = '📰';
    title = 'Лента пуста';
    desc = 'Пока что нет ни новостей, ни постов от сообществ. Загляните позже или создайте своё сообщество.';
    cta = el('div', { class: 'feed-empty-actions' },
      el('a', { class: 'btn', href: '/communities' }, 'Создать сообщество')
    );
  }

  card.appendChild(el('div', { class: 'feed-empty-icon' }, icon));
  card.appendChild(el('div', { class: 'feed-empty-title' }, title));
  card.appendChild(el('div', { class: 'feed-empty-desc' }, desc));
  if (cta) card.appendChild(cta);
  return card;
}

function paintFeedList(r) {
  const root = $('#feed-list');
  if (!root) return;
  root.innerHTML = '';

  const items = r?.items || [];
  if (!items.length) {
    root.appendChild(buildFeedEmpty(r?.scope || 'all'));
    // Surface server-side counts so misbehaviour can be diagnosed without DevTools.
    // Tiny grey line at the bottom of the empty card, nothing fancy.
    if (r && r._debug) {
      const d = r._debug;
      root.appendChild(el('div', {
        style: { fontSize: '10.5px', color: 'var(--mute)', textAlign: 'center', marginTop: '10px', opacity: '0.7' }
      }, `dbg: authed=${d.authed} · scope=${d.scope} · news=${d.news_count} · posts=${d.posts_total} · returned=${d.returned}`));
    }
    return;
  }

  for (const it of items) {
    const card = el('div', { class: 'feed-item card' });
    // Header: public name + verified + date
    card.appendChild(el('div', { class: 'feed-item-h' },
      el('div', { class: 'feed-pub' },
        el('div', { class: 'feed-pub-avatar' + (it.public_id === 'official' ? ' official' : '') },
          it.public_avatar
            ? el('img', { src: it.public_avatar, alt: '' })
            : (it.public_id === 'official'
                ? el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>' })
                : (it.public_name || '?').slice(0, 1).toUpperCase())
        ),
        el('div', null,
          el('div', { class: 'feed-pub-name' }, it.public_name,
            it.verified ? el('span', { class: 'feed-verified', title: 'Проверено', html:
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }) : null
          ),
          el('div', { class: 'feed-date' }, it.created_at ? relDate(it.created_at) : '')
        )
      ),
      it.kind === 'news'
        ? el('span', { class: 'feed-tag news' }, 'Новость')
        : el('div', { class: 'feed-h-right' },
            el('span', { class: 'feed-tag post' }, 'Пост'),
            it.post_id ? el('button', { class: 'feed-report', type: 'button', title: 'Пожаловаться',
              onclick: async () => {
                const reason = prompt('Причина жалобы (необязательно):') || '';
                const r = await api.report('post', String(it.post_id), reason).catch(() => ({ ok: false }));
                if (r.ok) toast.ok('Жалоба отправлена'); else toast.err('Не удалось');
              },
              html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>' }) : null
          )
    ));

    if (it.title) card.appendChild(el('div', { class: 'feed-item-title' }, it.title));
    const imgsNode = buildPostImages(it);
    if (imgsNode) card.appendChild(imgsNode);
    if (it.body) { const b = buildPostBody(it.body, it.kind === 'news'); if (b) card.appendChild(b); }
    if (it.poll) card.appendChild(buildPollCard(it.post_id, it.poll, window.__me));
    if (it.edited_at) card.appendChild(el('div', { class: 'feed-edited' }, '✎ изменено'));
    if (it.link) {
      card.appendChild(el('a', { class: 'feed-item-link', href: it.link, target: '_blank', rel: 'noopener' },
        'Читать полностью ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>' })
      ));
    }
    if (it.kind === 'post' && it.post_id) {
      const footer = buildPostFooter(it, window.__me);
      if (footer) card.appendChild(footer);
      markPostViewed(it.post_id);
    }
    root.appendChild(card);
  }
}

function paintFeedSide(r) {
  const root = $('#feed-side');
  if (!root) return;
  root.innerHTML = '';

  const card = el('div', { class: 'card' });
  // Title row with inline "+" create button
  card.appendChild(el('div', { class: 'feed-side-h' },
    el('div', { class: 'card-eyebrow', style: { margin: 0 } }, 'Паблики'),
    el('button', { class: 'feed-side-create', type: 'button', title: 'Создать паблик',
      onclick: () => openCreatePublicModal(),
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Создать</span>' })
  ));

  const publics = r?.publics || [];
  if (!publics.length) {
    card.appendChild(el('div', { class: 'feed-side-empty' },
      'Пока нет пабликов. Нажмите «Создать», чтобы сделать свой.'));
    root.appendChild(card);
    return;
  }

  const list = el('div', { class: 'feed-pub-list' });
  for (const p of publics) {
    const subBtn = el('button', {
      class: 'btn btn-sm' + (p.subscribed ? ' btn-ghost' : ''), type: 'button',
      onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const res = p.subscribed ? await api.unsubscribePublic(p.id) : await api.subscribePublic(p.id);
          if (res?.ok) { p.subscribed = res.subscribed; btn.textContent = p.subscribed ? 'Отписаться' : 'Подписаться';
            btn.classList.toggle('btn-ghost', p.subscribed); }
        } catch (_) { toast.err('Ошибка'); }
        finally { btn.disabled = false; }
      }
    }, p.subscribed ? 'Отписаться' : 'Подписаться');

    const row = el('div', { class: 'feed-pub-row' },
      el('div', { class: 'feed-pub-avatar sm' + (p.verified ? ' official' : '') },
        p.avatar ? el('img', { src: p.avatar, alt: '' }) : (p.name || '?').slice(0, 1).toUpperCase()),
      el('div', { class: 'feed-pub-row-info' },
        el('a', { class: 'feed-pub-name', href: `/feed?public=${encodeURIComponent(p.id)}` }, p.name,
          p.is_owner ? el('span', { class: 'feed-owner-tag' }, 'мой') : null),
        p.description ? el('div', { class: 'feed-pub-desc' }, p.description) : null
      ),
      p.can_post
        ? el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openCreatePostModal(p) }, 'Пост')
        : subBtn
    );
    list.appendChild(row);
  }
  card.appendChild(list);
  root.appendChild(card);
}

// Modal: manage public co-owners / editors (owner only)
// Modal: community owner stats — totals, week, daily growth chart, top posts
function openPublicStatsModal(pub) {
  const body = el('div', { class: 'stats-modal-body' });
  body.innerHTML = '<div class="loading-inline" style="padding:20px"><div class="spinner sm"></div>Загружаем статистику…</div>';
  openModal(`Статистика · ${pub.name}`, [body], async () => true, 'Закрыть');

  api.publicStats(pub.id).then(r => {
    if (!r?.ok) { body.innerHTML = '<div class="search-empty">Не удалось загрузить</div>'; return; }
    const s = r.stats;
    body.innerHTML = '';

    // Top-level totals as KPI cards
    const totals = el('div', { class: 'stats-kpi-grid' },
      kpiCard('👥 Подписчиков', s.totals.subscribers, `+${s.week.new_subscribers} за неделю`),
      kpiCard('📝 Постов', s.totals.posts, `${s.week.posts} за неделю`),
      kpiCard('❤️ Лайков', s.totals.likes, `${s.week.likes} за неделю`),
      kpiCard('💬 Комментариев', s.totals.comments, `${s.week.comments} за неделю`),
      kpiCard('👁 Просмотров', s.totals.views, `${s.week.views} за неделю`)
    );
    body.appendChild(totals);

    // Daily growth — SVG sparkline (last 30 days new subs per day)
    body.appendChild(el('div', { class: 'stats-section-h' }, 'Новые подписчики (30 дней)'));
    body.appendChild(buildSparkline(s.daily_growth));

    // Top posts by engagement
    if (s.top_posts?.length) {
      body.appendChild(el('div', { class: 'stats-section-h' }, 'Топ постов по вовлечённости'));
      const list = el('div', { class: 'stats-top-list' });
      for (const p of s.top_posts) {
        const link = el('a', { class: 'stats-top-row', href: `/feed?public=${encodeURIComponent(pub.id)}#post-${p.id}` });
        if (p.image) {
          const im = el('div', { class: 'stats-top-img' });
          im.appendChild(el('img', { src: p.image, alt: '' }));
          link.appendChild(im);
        }
        const info = el('div', { class: 'stats-top-info' });
        if (p.title) info.appendChild(el('div', { class: 'stats-top-title' }, p.title));
        info.appendChild(el('div', { class: 'stats-top-preview' }, p.body_preview));
        info.appendChild(el('div', { class: 'stats-top-stats' },
          `❤️ ${p.likes}  💬 ${p.comments}  👁 ${p.views}`));
        link.appendChild(info);
        list.appendChild(link);
      }
      body.appendChild(list);
    }
  }).catch(() => {
    body.innerHTML = '<div class="search-empty">Не удалось загрузить</div>';
  });
}

function kpiCard(label, value, sub) {
  return el('div', { class: 'stats-kpi' },
    el('div', { class: 'stats-kpi-label' }, label),
    el('div', { class: 'stats-kpi-value' }, String(value)),
    el('div', { class: 'stats-kpi-sub' }, sub)
  );
}

// SVG sparkline chart: array of {date, new_subscribers}
function buildSparkline(series) {
  const w = 500, h = 100, pad = 8;
  const max = Math.max(1, ...series.map(p => p.new_subscribers));
  const dx = (w - pad * 2) / Math.max(1, series.length - 1);
  const points = series.map((p, i) => {
    const x = pad + i * dx;
    const y = h - pad - (p.new_subscribers / max) * (h - pad * 2);
    return [x, y];
  });
  // Build path
  const path = points.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ');
  // Filled area under line
  const areaPath = path + ` L ${(w - pad).toFixed(1)},${(h - pad).toFixed(1)} L ${pad},${(h - pad).toFixed(1)} Z`;
  const wrap = el('div', { class: 'stats-spark-wrap' });
  wrap.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="stats-spark">
      <path d="${areaPath}" class="stats-spark-area"/>
      <path d="${path}" class="stats-spark-line"/>
      ${points.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" class="stats-spark-dot"/>`).join('')}
    </svg>
    <div class="stats-spark-axis">
      <span>${series[0]?.date?.slice(5) || ''}</span>
      <span>${series[series.length - 1]?.date?.slice(5) || ''}</span>
    </div>
  `;
  return wrap;
}

function openEditorsModal(pub) {
  const listBox = el('div', { class: 'editors-list' });
  const input = el('input', { class: 'modal-input', placeholder: 'SteamID, ссылка или ник Steam' });
  const reload = async () => {
    listBox.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Загрузка…</div>';
    const r = await api.publicEditors(pub.id).catch(() => ({ ok: false, editors: [] }));
    listBox.innerHTML = '';
    if (!r.editors?.length) {
      listBox.appendChild(el('div', { class: 'modal-hint' }, 'Редакторов пока нет. Они смогут публиковать посты в этом паблике.'));
    } else {
      for (const e of r.editors) {
        listBox.appendChild(el('div', { class: 'editor-row' },
          el('a', { class: 'editor-name', href: `/lookup?steamid=${encId(e.steam_id)}` }, e.name || e.steam_id),
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { await api.removePublicEditor(pub.id, e.steam_id); toast.ok('Удалён'); reload(); } }, 'Убрать')
        ));
      }
    }
  };
  openModal(`Редакторы · ${pub.name}`, [
    el('div', { class: 'modal-hint' },
      'Редакторы могут публиковать посты в ваш паблик. Удалять паблик и менять настройки может только владелец.'),
    listBox,
    el('label', { class: 'modal-label' }, 'Добавить редактора'),
    el('div', { class: 'admin-manual', style: { margin: 0 } },
      input,
      el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        const id = await api.resolveAny(input.value);
        if (!id) { toast.warn('Не нашли такого игрока'); return; }
        const r = await api.addPublicEditor(pub.id, id).catch(() => ({ ok: false }));
        if (r.ok) { toast.ok('Добавлен'); input.value = ''; reload(); }
        else toast.err(r.error === 'already-owner' ? 'Это владелец паблика' : 'Ошибка');
      } }, 'Добавить')
    )
  ], async () => true, 'Готово');
  reload();
}

// Modal: edit an existing public
function openEditPublicModal(pub, onDone) {
  const nameInput = el('input', { class: 'modal-input', maxlength: '60' }); nameInput.value = pub.name || '';
  const descInput = el('textarea', { class: 'modal-input', rows: '2', maxlength: '300' }); descInput.value = pub.description || '';
  const ava = imageUploadField('Аватар', pub.avatar || '');
  const cover = imageUploadField('Обложка (баннер)', pub.cover || '');
  const snapshot = JSON.stringify({ n: nameInput.value, d: descInput.value, a: ava.getUrl(), c: cover.getUrl() });
  openModal('Редактировать паблик', [
    el('label', { class: 'modal-label' }, 'Название'), nameInput,
    el('label', { class: 'modal-label' }, 'Описание'), descInput,
    ava.node, cover.node
  ], async () => {
    const name = nameInput.value.trim();
    if (name.length < 3) { toast.warn('Название минимум 3 символа'); return false; }
    const res = await api.updatePublic(pub.id, {
      name, description: descInput.value.trim(), avatar: ava.getUrl(), cover: cover.getUrl()
    }).catch(() => ({ ok: false }));
    if (res.ok) { toast.ok('Сохранено'); if (onDone) onDone(); return true; }
    toast.err('Не удалось сохранить'); return false;
  }, 'Сохранить', { guard: true, snapshot: () => JSON.stringify({ n: nameInput.value, d: descInput.value, a: ava.getUrl(), c: cover.getUrl() }), initialSnapshot: snapshot });
}

// Modal: create a public
function openCreatePublicModal() {
  const nameInput = el('input', { class: 'modal-input', placeholder: 'Название паблика', maxlength: '60' });
  const descInput = el('textarea', { class: 'modal-input', rows: '2', placeholder: 'Описание (необязательно)', maxlength: '300' });
  const ava = imageUploadField('Аватар', '');
  const cover = imageUploadField('Обложка (баннер)', '');
  openModal('Новый паблик', [
    el('label', { class: 'modal-label' }, 'Название'), nameInput,
    el('label', { class: 'modal-label' }, 'Описание'), descInput,
    ava.node,
    cover.node,
    el('div', { class: 'modal-hint' }, 'Вы становитесь владельцем паблика и сможете публиковать в него посты. До 5 пабликов на аккаунт.')
  ], async () => {
    const name = nameInput.value.trim();
    if (name.length < 3) { toast.warn('Название минимум 3 символа'); return false; }
    const res = await api.createPublic({ name, description: descInput.value.trim(), avatar: ava.getUrl(), cover: cover.getUrl() }).catch(() => ({ ok: false }));
    if (res.ok) { toast.ok('Паблик создан'); location.href = `/feed?public=${encodeURIComponent(res.public.id)}`; return true; }
    toast.err(res.error === 'too-many' ? 'Лимит 5 пабликов' : res.error === 'name-too-short' ? 'Название слишком короткое' : 'Ошибка');
    return false;
  }, 'Создать', { guard: true });
}

// Modal: create or edit a post.
// If `existing` is provided → edit mode. Otherwise → create.
function openCreatePostModal(pub, existing) {
  const isEdit = !!existing;
  const titleInput = el('input', { class: 'modal-input', placeholder: 'Заголовок (необязательно)', maxlength: '200' });
  const bodyInput = el('textarea', { class: 'modal-input', rows: '5', placeholder: 'Текст поста…', maxlength: '5000' });
  const linkInput = el('input', { class: 'modal-input', placeholder: 'Ссылка (необязательно)', maxlength: '500' });
  const initialImages = existing?.images?.length ? existing.images : (existing?.image ? [existing.image] : []);
  const img = multiImageUploadField('Картинки (до 6)', initialImages);
  if (isEdit) {
    titleInput.value = existing.title || '';
    bodyInput.value = existing.body || '';
    linkInput.value = existing.link || '';
  }

  // Poll builder
  const pollBox = el('div', { class: 'poll-builder', style: { display: 'none' } });
  let pollOpts = []; // array of {input element}
  const renderPollOpts = () => {
    const list = pollBox.querySelector('.poll-builder-opts');
    if (!list) return;
    list.innerHTML = '';
    pollOpts.forEach((o, i) => {
      const row = el('div', { class: 'poll-builder-row' },
        o.input,
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
          if (pollOpts.length <= 2) { toast.warn('Минимум 2 варианта'); return; }
          pollOpts.splice(i, 1); renderPollOpts();
        }, html: '×' })
      );
      list.appendChild(row);
    });
  };
  const addPollOpt = (value = '') => {
    if (pollOpts.length >= 6) { toast.warn('Максимум 6 вариантов'); return; }
    const inp = el('input', { class: 'modal-input', placeholder: `Вариант ${pollOpts.length + 1}`, maxlength: '80', value });
    pollOpts.push({ input: inp });
    renderPollOpts();
  };
  const pollQuestion = el('input', { class: 'modal-input', placeholder: 'Вопрос опроса', maxlength: '200' });
  pollBox.appendChild(el('label', { class: 'modal-label' }, 'Опрос'));
  pollBox.appendChild(pollQuestion);
  pollBox.appendChild(el('div', { class: 'poll-builder-opts' }));
  pollBox.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
    style: { marginTop: '6px' }, onclick: () => addPollOpt() }, '+ Вариант'));

  // If existing has a poll, pre-fill
  if (isEdit && existing.poll) {
    pollBox.style.display = '';
    pollQuestion.value = existing.poll.question || '';
    for (const o of (existing.poll.options || [])) addPollOpt(o.text || '');
  }

  const togglePoll = el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
    style: { marginTop: '6px' }, onclick: () => {
      if (pollBox.style.display === 'none') {
        pollBox.style.display = '';
        if (pollOpts.length === 0) { addPollOpt(); addPollOpt(); }
        togglePoll.textContent = '− Убрать опрос';
      } else {
        pollBox.style.display = 'none';
        pollOpts = []; pollQuestion.value = '';
        renderPollOpts();
        togglePoll.textContent = '+ Добавить опрос';
      }
    } }, isEdit && existing.poll ? '− Убрать опрос' : '+ Добавить опрос');

  openModal(isEdit ? 'Редактировать пост' : `Новый пост · ${pub.name}`, [
    titleInput, bodyInput,
    el('label', { class: 'modal-label' }, 'Ссылка'), linkInput,
    img.node,
    togglePoll, pollBox
  ], async () => {
    const body = bodyInput.value.trim();
    const title = titleInput.value.trim();
    if (!body && !title) { toast.warn('Введите текст или заголовок'); return false; }

    // Build poll payload if present
    let poll = null;
    if (pollBox.style.display !== 'none' && pollOpts.length >= 2) {
      const opts = pollOpts.map(o => o.input.value.trim()).filter(Boolean);
      if (opts.length < 2) { toast.warn('Опрос: минимум 2 варианта с текстом'); return false; }
      poll = { question: pollQuestion.value.trim(), options: opts };
    } else if (isEdit && existing.poll && pollBox.style.display === 'none') {
      // Remove poll from existing post
      poll = null;
    }

    const imageUrls = img.getUrls();
    const payload = {
      title, body, link: linkInput.value.trim(),
      image: imageUrls[0] || null,
      images: imageUrls
    };
    if (isEdit) {
      // For edits, only send poll if it changed (or removed)
      if (poll !== null) payload.poll = poll;
      else if (existing.poll) payload.poll = null;
      const res = await api.updatePost(existing.post_id || existing.id, payload).catch(() => ({ ok: false }));
      if (res.ok) { toast.ok('Сохранено'); location.reload(); return true; }
      toast.err('Не удалось сохранить');
      return false;
    } else {
      payload.public_id = pub.id;
      if (poll) payload.poll = poll;
      const res = await api.createPost(payload).catch(() => ({ ok: false }));
      if (res.ok) { toast.ok('Опубликовано'); location.reload(); return true; }
      toast.err('Не удалось опубликовать');
      return false;
    }
  }, isEdit ? 'Сохранить' : 'Опубликовать', { guard: !isEdit });
}

// Image upload field: button + hidden file input + preview. Returns { node, getUrl }.
function imageUploadField(label, initialUrl) {
  let url = initialUrl || '';
  const preview = el('div', { class: 'upload-preview' });
  const renderPreview = () => {
    preview.innerHTML = '';
    if (url) {
      preview.appendChild(el('img', { src: url, alt: '' }));
      preview.appendChild(el('button', { class: 'upload-clear', type: 'button', title: 'Убрать',
        onclick: () => { url = ''; renderPreview(); }, html: '&times;' }));
    }
  };
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' } });
  const btn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => fileInput.click() }, 'Загрузить файл');
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast.err('Файл больше 5 МБ'); return; }
    btn.disabled = true; btn.textContent = 'Загрузка…';
    const r = await api.upload(f).catch(() => ({ ok: false }));
    btn.disabled = false; btn.textContent = 'Загрузить файл';
    if (r.ok && r.url) { url = r.url; renderPreview(); toast.ok('Загружено'); }
    else toast.err(r.error === 'too-large' ? 'Файл больше 5 МБ' : r.error === 'not-an-image' ? 'Это не картинка' : 'Не удалось загрузить');
    fileInput.value = '';
  });
  const node = el('div', { class: 'upload-field' },
    label ? el('label', { class: 'modal-label' }, label) : null,
    el('div', { class: 'upload-controls' }, btn),
    preview
  );
  renderPreview();
  return { node, getUrl: () => url };
}

// Multi-image upload — up to 6 images, with thumbnails + remove buttons
function multiImageUploadField(label, initialUrls) {
  let urls = Array.isArray(initialUrls) ? initialUrls.filter(Boolean).slice(0, 6) : [];
  const list = el('div', { class: 'multi-upload-list' });
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, style: { display: 'none' } });
  const addBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
    onclick: () => { if (urls.length >= 6) { toast.warn('Максимум 6 картинок'); return; } fileInput.click(); }
  }, '+ Добавить картинку');

  const renderList = () => {
    list.innerHTML = '';
    urls.forEach((u, i) => {
      const item = el('div', { class: 'multi-upload-item' },
        el('img', { src: u, alt: '' }),
        el('button', { class: 'multi-upload-remove', type: 'button', title: 'Убрать',
          onclick: () => { urls.splice(i, 1); renderList(); }, html: '&times;' })
      );
      list.appendChild(item);
    });
    addBtn.style.opacity = urls.length >= 6 ? 0.5 : 1;
  };

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    fileInput.value = '';
    for (const f of files) {
      if (urls.length >= 6) break;
      if (f.size > 5 * 1024 * 1024) { toast.err(`${f.name}: больше 5 МБ`); continue; }
      const r = await api.upload(f).catch(() => ({ ok: false }));
      if (r.ok && r.url) urls.push(r.url);
      else toast.err(r.error === 'too-large' ? `${f.name}: больше 5 МБ` : `${f.name}: ошибка`);
    }
    renderList();
  });

  const node = el('div', { class: 'upload-field' },
    label ? el('label', { class: 'modal-label' }, label) : null,
    list,
    el('div', { class: 'upload-controls' }, addBtn)
  );
  renderList();
  return { node, getUrls: () => urls.slice() };
}

// Generic modal helper
// openModal supports two call shapes:
//   openModal(title, contentNodes, onConfirm, confirmLabel)
//   openModal(title, contentNodes, onConfirm, confirmLabel, { guard: true })
// guard=true → asks before closing if any text input/textarea inside has non-empty content
function openModal(title, contentNodes, onConfirm, confirmLabel = 'OK', opts = {}) {
  const existing = $('#modal-host'); if (existing) existing.remove();
  const host = el('div', { id: 'modal-host', class: 'modal-host' });

  // Check whether any input inside the modal has content the user might lose
  const hasUnsavedInput = () => {
    if (!opts.guard) return false;
    // If snapshot mode is provided — compare against initial
    if (typeof opts.snapshot === 'function' && opts.initialSnapshot != null) {
      return opts.snapshot() !== opts.initialSnapshot;
    }
    // Otherwise — any non-empty input/textarea counts as unsaved
    const inputs = host.querySelectorAll('input, textarea');
    for (const inp of inputs) {
      if (inp.type === 'hidden' || inp.readOnly) continue;
      const v = String(inp.value || '').trim();
      if (v.length > 0) return true;
    }
    return false;
  };

  const close = (force = false) => {
    if (!force && hasUnsavedInput()) {
      if (!confirm('У вас есть несохранённые изменения. Закрыть всё равно?')) return;
    }
    host.remove();
  };

  const confirmBtn = el('button', { class: 'btn', type: 'button' }, confirmLabel);
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const keep = await onConfirm();
    if (keep) close(true);  // confirmed save = bypass guard
    else confirmBtn.disabled = false;
  });
  const dialog = el('div', { class: 'modal-dialog' },
    el('div', { class: 'modal-head' },
      el('div', { class: 'modal-title' }, title),
      el('button', { class: 'modal-x', type: 'button', onclick: () => close(), html: '&times;' })
    ),
    el('div', { class: 'modal-body' }, ...contentNodes),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => close() }, 'Отмена'),
      confirmBtn
    )
  );
  host.appendChild(dialog);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  // Escape key closes (with guard)
  const onEsc = (e) => {
    if (e.key === 'Escape' && document.body.contains(host)) {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onEsc);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      document.removeEventListener('keydown', onEsc);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });

  document.body.appendChild(host);
}

// Strip HTML/bbcode-ish noise from Steam news bodies for a clean feed preview
function stripFeedHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\/?[^\]]+\]/g, ' ')   // [b]...[/b], [url=...] bbcode
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Render a small role badge next to a user's name. Returns null if no role.
function roleBadge(role) {
  if (!role || !role.name) return null;
  const color = String(role.color || 'green').replace(/[^a-z]/gi, '').toLowerCase();
  return el('span', { class: 'role-badge role-color-' + color, title: role.name }, role.name);
}

// Relative date in Russian
// Build a short Russian presence label, e.g.:
//   { online: true, in_game: {name:'Counter-Strike 2'} } → "в сети · играет в Counter-Strike 2"
//   { online: false, last_seen: ISO } → "был 5 мин назад"
//   { hidden: true } → "" (no label)
function presenceLabel(presence) {
  if (!presence || presence.hidden) return '';
  const parts = [];
  if (presence.online) parts.push('в сети');
  else if (presence.last_seen) parts.push('был ' + relDate(presence.last_seen));
  if (presence.in_game && presence.in_game.name) {
    parts.push('играет в ' + presence.in_game.name);
  }
  return parts.join(' · ');
}

// Returns 'online' | 'in-game' | 'offline' for color coding the dot
function presenceState(presence) {
  if (!presence || presence.hidden) return 'offline';
  if (presence.in_game) return 'in-game';
  if (presence.online) return 'online';
  return 'offline';
}

// Build a small status dot — used overlayed on avatars in lists
function presenceDot(presence) {
  const state = presenceState(presence);
  if (state === 'offline') return null;
  return el('span', { class: 'presence-dot presence-' + state, title: presenceLabel(presence) });
}

function relDate(iso) {
  const d = Date.parse(iso);
  if (!d) return '';
  const diff = Date.now() - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${pluralDays(days)} назад`;
  return shortDate(iso);
}

// Show a small popup menu at (x,y) with Reply / Forward actions — triggered by long-press on mobile.
function openMessageActionMenu(x, y, { onReply, onForward, onReact, onDelete }) {
  document.querySelectorAll('.msgr-action-menu, .msgr-action-menu-backdrop').forEach(n => n.remove());
  const backdrop = el('div', { class: 'msgr-action-menu-backdrop' });
  const menu = el('div', { class: 'msgr-action-menu' });
  const close = () => { backdrop.remove(); menu.remove(); };

  // Reactions row — quick emoji picker at the top
  if (onReact) {
    const reactRow = el('div', { class: 'msgr-action-react-row' });
    for (const e of ['👍', '❤️', '😂', '😮', '😢', '🔥']) {
      const b = el('button', { type: 'button', class: 'msgr-action-react-btn' }, e);
      b.addEventListener('click', () => { close(); onReact(e); });
      reactRow.appendChild(b);
    }
    menu.appendChild(reactRow);
  }

  const replyBtn = el('button', { type: 'button',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span>Ответить</span>'
  });
  replyBtn.addEventListener('click', () => { close(); onReply(); });

  const forwardBtn = el('button', { type: 'button',
    html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span>Переслать</span>'
  });
  forwardBtn.addEventListener('click', () => { close(); onForward(); });

  menu.appendChild(replyBtn);
  menu.appendChild(forwardBtn);
  if (onDelete) {
    const deleteBtn = el('button', { type: 'button', class: 'msgr-action-danger',
      html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Удалить</span>'
    });
    deleteBtn.addEventListener('click', () => { close(); onDelete(); });
    menu.appendChild(deleteBtn);
  }
  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.min(x, vw - rect.width - 8);
  let top = Math.min(y, vh - rect.height - 8);
  left = Math.max(8, left);
  top = Math.max(8, top);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

// Forward a message to another friend — opens a friend picker, then sends.
async function openForwardPicker(messageId) {
  const listBox = el('div', { class: 'share-list' });
  listBox.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Друзья…</div>';
  openModal('Переслать сообщение', [
    el('div', { class: 'modal-hint' }, 'Выберите кому переслать.'),
    listBox
  ], async () => true, 'Закрыть');

  const r = await api.friends().catch(() => ({ ok: false, friends: [] }));
  listBox.innerHTML = '';
  const friends = r.friends || [];
  if (!friends.length) { listBox.appendChild(el('div', { class: 'share-empty' }, 'Нет друзей на сайте.')); return; }
  for (const f of friends) {
    const row = el('button', { class: 'share-row', type: 'button' });
    const ava = el('div', { class: 'share-ava' });
    if (f.avatar) {
      const img = el('img', { src: f.avatar, alt: '' });
      img.onerror = function () { this.remove(); ava.textContent = (f.name || '?').slice(0, 1).toUpperCase(); };
      ava.appendChild(img);
    } else ava.textContent = (f.name || '?').slice(0, 1).toUpperCase();
    row.appendChild(ava);
    row.appendChild(el('div', { class: 'share-name' }, f.name));
    const tag = el('span', { class: 'share-send-tag' }, 'Переслать');
    row.appendChild(tag);
    row.addEventListener('click', async () => {
      row.disabled = true; tag.textContent = '…';
      const res = await api.sendMessage(f.steam_id, '', { type: 'forward', message_id: messageId }).catch(() => ({ ok: false }));
      if (res.ok) { tag.textContent = 'Отправлено ✓'; tag.classList.add('sent'); }
      else { tag.textContent = 'Ошибка'; row.disabled = false; }
    });
    listBox.appendChild(row);
  }
}

// ============ page: messages ============
async function pageMessages() {
  const me = await renderTopbar('messages');
  if (!me.logged_in) {
    toast.warn('Войдите через Steam, чтобы открыть сообщения');
    setTimeout(() => location.replace('/'), 800);
    return;
  }
  const empty = $('#msgr-empty');
  if (empty && !empty.querySelector('.empty-state-actions')) {
    empty.appendChild(el('div', { class: 'empty-state-actions' },
      el('a', { class: 'btn btn-sm', href: '/friends' }, 'Найти друзей'),
      el('a', { class: 'btn btn-sm btn-ghost', href: '/lookup' }, 'Проверить игрока')
    ));
  }

  const readMsgPageCache = (key, maxAgeMs = 45000) => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(`sok:msg:${key}`) || 'null');
      if (!cached || Date.now() - cached.ts > maxAgeMs) return null;
      return cached.value;
    } catch (_) { return null; }
  };
  const writeMsgPageCache = (key, value) => {
    try { sessionStorage.setItem(`sok:msg:${key}`, JSON.stringify({ ts: Date.now(), value })); } catch (_) {}
  };

  const state = {
    tab: 'chats',
    activeOther: null,
    pollTimer: null,
    convos: readMsgPageCache('convos'),
    friendsData: readMsgPageCache('friends'),
    threadCache: new Map(),
    threadFetchToken: 0,
    lastLeftRefresh: 0
  };

  // Tabs
  const tabs = $('#msgr-tabs');
  if (tabs) {
    for (const btn of tabs.querySelectorAll('.msgr-tab')) {
      btn.addEventListener('click', () => {
        for (const b of tabs.querySelectorAll('.msgr-tab')) b.classList.remove('active');
        btn.classList.add('active');
        state.tab = btn.dataset.tab;
        state.leftRendered = false; // different content — show spinner once
        renderLeft();
      });
    }
  }

  async function renderLeft(opts = {}) {
    const list = $('#msgr-list');
    if (!list) return;
    const cached = state.tab === 'chats' ? state.convos : state.friendsData;
    if (cached && !opts.force) {
      if (state.tab === 'chats') renderChatList(cached);
      else renderFriendList(cached);
      state.leftRendered = true;
      if (opts.localOnly) return;
    }
    // Show spinner only when there is nothing useful to show yet.
    const isFirst = !state.leftRendered && !cached;
    if (isFirst && !opts.silent) {
      list.innerHTML = '<div class="loading-inline" style="padding:20px"><div class="spinner sm"></div>Загрузка…</div>';
    }
    if (state.tab === 'chats') {
      const r = await api.conversations().catch(() => ({ ok: false, conversations: [] }));
      state.convos = r.conversations || [];
      writeMsgPageCache('convos', state.convos);
      renderChatList(state.convos);
    } else {
      const r = await api.friends().catch(() => ({ ok: false, friends: [], incoming: [], outgoing: [] }));
      state.friendsData = r;
      writeMsgPageCache('friends', state.friendsData);
      renderFriendList(state.friendsData);
    }
    state.leftRendered = true;
    state.lastLeftRefresh = Date.now();
  }

  function renderChatList(convos) {
    const list = $('#msgr-list');
    list.innerHTML = '';
    if (!convos.length) {
      list.appendChild(el('div', { class: 'msgr-list-empty' },
        el('div', { class: 'msgr-empty-title-sm' }, 'Диалогов пока нет'),
        el('div', null, 'Добавьте игрока в друзья — после подтверждения здесь появится переписка.'),
        el('div', { class: 'empty-state-actions' },
          el('a', { class: 'btn btn-sm', href: '/friends' }, 'Найти друзей'),
          el('a', { class: 'btn btn-sm btn-ghost', href: '/lookup' }, 'Проверить игрока')
        )
      ));
      return;
    }
    for (const c of convos) {
      const ava = avatarEl(c.avatar, c.name, 'msgr-avatar');
      ava.dataset.sid = c.steam_id;
      list.appendChild(el('div', {
        class: 'msgr-convo' + (state.activeOther === c.steam_id ? ' active' : ''),
        dataset: { sid: c.steam_id },
        onclick: () => openThread(c.steam_id)
      },
        ava,
        el('div', { class: 'msgr-convo-body' },
          el('div', { class: 'msgr-convo-top' },
            el('span', { class: 'msgr-convo-name' }, c.name),
            el('span', { class: 'msgr-convo-time' }, c.last_at ? relDate(c.last_at) : '')
          ),
          el('div', { class: 'msgr-convo-bottom' },
            el('span', { class: 'msgr-convo-preview' },
              (c.last_from_me ? 'Вы: ' : '') + (c.last_text || '')),
            c.unread > 0 ? el('span', { class: 'msgr-unread' }, String(c.unread)) : null
          )
        )
      ));
    }
    // Batch fetch presence and decorate avatars
    const ids = convos.map(c => c.steam_id);
    if (ids.length) {
      api.presence(ids).then(r => {
        if (!r?.ok) return;
        for (const av of list.querySelectorAll('.msgr-avatar')) {
          const sid = av.dataset.sid;
          if (sid && r.presence[sid]) setAvatarPresence(av, r.presence[sid]);
        }
      }).catch(() => {});
    }
  }

  function renderFriendList(r) {
    const list = $('#msgr-list');
    list.innerHTML = '';
    const sections = [];
    if ((r.incoming || []).length) sections.push(['Заявки в друзья', r.incoming, 'incoming']);
    if ((r.outgoing || []).length) sections.push(['Исходящие заявки', r.outgoing, 'outgoing']);
    sections.push(['Друзья', r.friends || [], 'friends']);

    let any = false;
    for (const [title, arr, kind] of sections) {
      if (!arr.length && kind !== 'friends') continue;
      list.appendChild(el('div', { class: 'msgr-section-h' }, title));
      if (!arr.length) {
        list.appendChild(el('div', { class: 'msgr-list-empty' },
          el('div', { class: 'msgr-empty-title-sm' }, 'Друзей пока нет'),
          el('div', null, 'Найдите игрока, отправьте заявку и после принятия сможете написать ему прямо отсюда.'),
          el('div', { class: 'empty-state-actions' },
            el('a', { class: 'btn btn-sm', href: '/friends' }, 'Найти игрока'),
            el('a', { class: 'btn btn-sm btn-ghost', href: '/feed' }, 'Открыть ленту')
          )
        ));
        continue;
      }
      for (const f of arr) {
        any = true;
        const actions = el('div', { class: 'msgr-friend-actions' });
        if (kind === 'friends') {
          actions.appendChild(el('button', { class: 'btn btn-sm', type: 'button',
            onclick: (e) => { e.stopPropagation(); openThread(f.steam_id); } }, 'Написать'));
        } else if (kind === 'incoming') {
          actions.appendChild(el('button', { class: 'btn btn-sm', type: 'button',
            onclick: async (e) => { e.stopPropagation(); await api.friendAccept(f.steam_id); toast.ok('Заявка принята'); renderLeft(); } }, 'Принять'));
          actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async (e) => { e.stopPropagation(); await api.friendRemove(f.steam_id); renderLeft(); } }, 'Отклонить'));
        } else {
          actions.appendChild(el('span', { class: 'msgr-pending' }, 'Ожидает'));
          actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async (e) => { e.stopPropagation(); await api.friendRemove(f.steam_id); renderLeft(); } }, 'Отменить'));
        }
        list.appendChild(el('div', { class: 'msgr-friend' },
          avatarEl(f.avatar, f.name, 'msgr-avatar'),
          el('a', { class: 'msgr-friend-name', href: `/lookup?steamid=${encId(f.steam_id)}` }, f.name),
          actions
        ));
      }
    }
  }

  function markActiveConvo(other) {
    const list = $('#msgr-list');
    if (!list) return;
    for (const row of list.querySelectorAll('.msgr-convo')) {
      const isActive = row.dataset.sid === other;
      row.classList.toggle('active', isActive);
      if (isActive) row.querySelector('.msgr-unread')?.remove();
    }
  }

  async function openThread(other) {
    if (state.activeOther === other && $('#msgr-thread-scroll')) {
      document.body.classList.add('msgr-thread-open');
      tellServiceWorkerActiveMessagePeer(other);
      markActiveConvo(other);
      const token = ++state.threadFetchToken;
      const r = await api.messages(other).catch(() => ({ ok: false }));
      if (token !== state.threadFetchToken || state.activeOther !== other || !r.ok) return;
      state.threadCache.set(other, r);
      renderThreadResponse(r);
      refreshUnreadBadge();
      return;
    }
    state.activeOther = other;
    tellServiceWorkerActiveMessagePeer(other);
    try {
      const url = new URL(location.href);
      url.pathname = '/messages';
      url.search = '';
      url.searchParams.set('to', other);
      history.replaceState(history.state, '', url.pathname + url.search);
    } catch (_) {}
    state.lastMsgId = 0;
    state.lastDate = null;
    state.threadLoaded = false;
    state.replyToId = null;
    document.body.classList.add('msgr-thread-open'); // mobile: show thread, hide list
    markActiveConvo(other);
    const right = $('#msgr-right');
    const cached = state.threadCache.get(other);
    if (cached) {
      paintThread(cached, { fromCache: true });
    } else {
      right.innerHTML = '<div class="loading-inline" style="padding:40px;justify-content:center"><div class="spinner"></div></div>';
    }
    const token = ++state.threadFetchToken;
    const r = await api.messages(other).catch(() => ({ ok: false }));
    if (token !== state.threadFetchToken || state.activeOther !== other) return;
    if (!r.ok) {
      right.innerHTML = '';
      right.appendChild(el('div', { class: 'msgr-empty' },
        el('div', { class: 'msgr-empty-title' }, 'Не удалось загрузить диалог'),
        el('div', { class: 'msgr-empty-sub' }, 'Связь могла просесть. Попробуйте открыть чат ещё раз.'),
        el('div', { class: 'empty-state-actions' },
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openThread(other) }, 'Повторить'),
          el('a', { class: 'btn btn-sm btn-ghost', href: '/messages' }, 'К списку')
        )
      ));
      return;
    }
    state.threadCache.set(other, r);
    if (cached && $('#msgr-thread-scroll')) {
      renderThreadResponse(r);
      state.threadFriend = r.friend;
    } else {
      paintThread(r);
    }
    if (Array.isArray(state.convos)) {
      state.convos = state.convos.map(c => c.steam_id === other ? { ...c, unread: 0 } : c);
      writeMsgPageCache('convos', state.convos);
      markActiveConvo(other);
    }
    refreshUnreadBadge(); // opening marks read
    loadThreadPresence(other);
  }

  async function loadThreadPresence(steamId) {
    const r = await api.presence([steamId]).catch(() => null);
    const p = r?.ok ? r.presence[steamId] : null;
    // Attach a role badge to the thread name (idempotent — remove old badge first)
    const nameNode = document.querySelector('.msgr-thread-name');
    if (nameNode) {
      const old = nameNode.parentElement?.querySelector(':scope > .role-badge'); if (old) old.remove();
      const rb = p?.role ? roleBadge(p.role) : null;
      if (rb) nameNode.parentElement?.insertBefore(rb, nameNode.nextSibling);
    }
    const node = $('#msgr-thread-presence');
    if (!node) return;
    const lbl = presenceLabel(p);
    if (!lbl) { node.textContent = ''; node.className = 'msgr-thread-presence'; return; }
    node.innerHTML = '';
    const st = presenceState(p);
    node.className = 'msgr-thread-presence msgr-thread-presence-' + st;
    node.appendChild(el('span', { class: 'presence-dot presence-' + st }));
    node.appendChild(document.createTextNode(' ' + lbl));
  }

  function cacheActiveThreadResponse(r) {
    if (!r?.ok || !state.activeOther) return;
    state.threadCache.set(state.activeOther, r);
  }

  function appendMessageToThreadCache(peer, message) {
    if (!peer || !message?.id) return;
    const cached = state.threadCache.get(peer);
    if (!cached?.ok) return;
    const existing = cached.messages || [];
    if (existing.some(m => m.id === message.id)) return;
    cached.messages = [...existing, message];
    state.threadCache.set(peer, cached);
  }

  function renderThreadResponse(r) {
    if (!r?.ok) return;
    const messages = r.messages || [];
    const latest = messages[messages.length - 1];
    const scroll = $('#msgr-thread-scroll');
    if (scroll && latest?.id != null && latest.id <= state.lastMsgId &&
        !scroll.querySelector(`.msgr-bubble-row[data-mid="${latest.id}"]`)) {
      paintThread(r);
      return;
    }
    renderMessages(messages);
  }

  // Append only messages we haven't drawn yet (by id), inserting date separators as needed.
  function messageTimeNode(m) {
    const node = el('div', { class: 'msgr-bubble-time' }, m.created_at ? msgTime(m.created_at) : '');
    if (m.from_me) {
      node.appendChild(el('span', {
        class: 'msgr-receipt ' + (m.read ? 'seen' : 'sent'),
        title: m.read ? 'Прочитано' : 'Отправлено'
      },
        el('span', { class: 'msgr-receipt-checks' }, m.read ? '✓✓' : '✓'),
        el('span', { class: 'msgr-receipt-label' }, m.read ? 'Прочитано' : 'Отправлено')
      ));
    }
    return node;
  }

  function updateReceiptForMessage(m) {
    if (!m?.from_me || !m.read || m.id == null) return;
    const row = document.querySelector(`.msgr-bubble-row[data-mid="${m.id}"]`);
    const receipt = row?.querySelector('.msgr-receipt');
    if (!receipt) return;
    const checks = receipt.querySelector('.msgr-receipt-checks');
    const label = receipt.querySelector('.msgr-receipt-label');
    if (checks) checks.textContent = '✓✓';
    if (label) label.textContent = 'Прочитано';
    receipt.classList.remove('sent');
    receipt.classList.add('seen');
    receipt.title = 'Прочитано';
  }

  function markOutgoingSeen() {
    document.querySelectorAll('.msgr-bubble-row.me .msgr-receipt').forEach(r => {
      const checks = r.querySelector('.msgr-receipt-checks');
      const label = r.querySelector('.msgr-receipt-label');
      if (checks) checks.textContent = '✓✓';
      if (label) label.textContent = 'Прочитано';
      r.classList.remove('sent');
      r.classList.add('seen');
      r.title = 'Прочитано';
    });
  }

  function renderMessages(messages) {
    const scroll = $('#msgr-thread-scroll');
    if (!scroll) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    let added = false;
    let gotIncoming = false;
    for (const m of messages) {
      if (m.id != null && m.id <= state.lastMsgId) {
        updateReceiptForMessage(m);
        continue; // already drawn
      }
      const d = m.created_at ? new Date(m.created_at).toDateString() : null;
      if (d && d !== state.lastDate) {
        scroll.appendChild(el('div', { class: 'msgr-date-sep' },
          el('span', null, msgDateLabel(m.created_at))));
        state.lastDate = d;
      }
      // Bubble contents: optional attachment card → text → time
      const bubble = el('div', { class: 'msgr-bubble' });
      if (m.deleted) {
        bubble.appendChild(el('div', { class: 'msgr-bubble-text msgr-deleted' }, '🗑 Сообщение удалено'));
        bubble.appendChild(messageTimeNode(m));
      } else {
        if (m.attachment) {
          const card = buildAttachmentCard(m.attachment);
          if (card) bubble.appendChild(card);
        }
        if (m.text) {
          bubble.appendChild(el('div', { class: 'msgr-bubble-text' }, m.text));
        }
        bubble.appendChild(messageTimeNode(m));
        // Reactions chips (below bubble text). Filled by renderReactions helper.
        const reactionsEl = el('div', { class: 'msgr-reactions' });
        bubble.appendChild(reactionsEl);
        renderReactionsInto(reactionsEl, m.id, m.reactions || {}, window.__me);
      }
      // Action buttons (reply, forward, react) — visible on hover (desktop) / always (mobile)
      const actions = el('div', { class: 'msgr-bubble-actions' },
        el('button', { class: 'msgr-bubble-act', type: 'button', title: 'Реакция',
          'data-act': 'react', 'data-mid': String(m.id || ''),
          html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>' }),
        el('button', { class: 'msgr-bubble-act', type: 'button', title: 'Ответить',
          'data-act': 'reply', 'data-mid': String(m.id || ''),
          html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>' }),
        el('button', { class: 'msgr-bubble-act', type: 'button', title: 'Переслать',
          'data-act': 'forward', 'data-mid': String(m.id || ''),
          html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>' })
      );
      scroll.appendChild(el('div', { class: 'msgr-bubble-row ' + (m.from_me ? 'me' : 'them'),
        'data-mid': m.id != null ? String(m.id) : '' },
        bubble, actions
      ));
      if (m.id != null && m.id > state.lastMsgId) state.lastMsgId = m.id;
      if (!m.from_me) gotIncoming = true;
      added = true;
    }
    if (added && nearBottom) {
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
    if (state.threadLoaded && gotIncoming) playNotifySound();
    state.threadLoaded = true;
  }

  // Render an inline attachment card (post / reply / forward)
  // Render emoji reaction chips into a node — clickable to toggle own reaction
  function renderReactionsInto(node, msgId, reactions, me) {
    node.innerHTML = '';
    const keys = Object.keys(reactions || {});
    if (!keys.length) { node.style.display = 'none'; return; }
    node.style.display = '';
    for (const emoji of keys) {
      const users = reactions[emoji] || [];
      const mine = !!(me?.steamid && users.includes(me.steamid));
      const chip = el('button', { class: 'msgr-react-chip' + (mine ? ' mine' : ''), type: 'button',
        title: users.length + ' ' + plural(users.length, ['реакция', 'реакции', 'реакций'])
      },
        el('span', { class: 'msgr-react-emo' }, emoji),
        el('span', { class: 'msgr-react-count' }, String(users.length))
      );
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!me?.logged_in) { toast.warn('Войдите чтобы реагировать'); return; }
        const r = await api.reactToMessage(msgId, emoji).catch(() => ({ ok: false }));
        if (r.ok) renderReactionsInto(node, msgId, r.reactions, me);
      });
      node.appendChild(chip);
    }
  }

  // External helper used by long-press menu: find the bubble's reactions slot and refresh it
  function updateBubbleReactions(row, reactions) {
    if (!row) return;
    const slot = row.querySelector('.msgr-reactions');
    const mid = parseInt(row.dataset.mid, 10);
    if (slot && Number.isFinite(mid)) renderReactionsInto(slot, mid, reactions, window.__me);
  }
  // expose to closure
  window.__updateBubbleReactions = updateBubbleReactions;

  function buildAttachmentCard(att) {
    if (!att) return null;
    if (att.missing) {
      return el('div', { class: 'msg-att msg-att-missing' }, 'Вложение недоступно');
    }
    if (att.type === 'post') {
      const link = `${location.origin}/feed?public=${encodeURIComponent(att.public_id)}#post-${att.post_id}`;
      const card = el('a', { class: 'msg-att msg-att-post', href: link });
      if (att.image) card.appendChild(el('div', { class: 'msg-att-img' }, el('img', { src: att.image, alt: '' })));
      const body = el('div', { class: 'msg-att-body' });
      const head = el('div', { class: 'msg-att-head' });
      if (att.public_avatar) {
        const av = el('div', { class: 'msg-att-ava' });
        av.appendChild(el('img', { src: att.public_avatar, alt: '' }));
        head.appendChild(av);
      }
      head.appendChild(el('div', { class: 'msg-att-pub' }, att.public_name || 'Сообщество'));
      body.appendChild(head);
      if (att.title) body.appendChild(el('div', { class: 'msg-att-title' }, att.title));
      if (att.body_preview) body.appendChild(el('div', { class: 'msg-att-preview' }, att.body_preview));
      body.appendChild(el('div', { class: 'msg-att-cta' }, 'Открыть пост →'));
      card.appendChild(body);
      return card;
    }
    if (att.type === 'profile') {
      const sid = att.steam_id || '';
      const link = att.url || (isSteamId(sid) ? `/u/${encId(sid)}` : `/lookup?steamid=${encId(sid)}`);
      const card = el('a', { class: 'msg-att msg-att-profile', href: link });
      if (att.image) card.appendChild(el('div', { class: 'msg-att-img' }, el('img', { src: att.image, alt: '' })));
      const row = el('div', { class: 'msg-att-profile-row' });
      const ava = el('div', { class: 'msg-att-profile-ava' });
      if (att.avatar) {
        const img = el('img', { src: att.avatar, alt: '' });
        img.onerror = function() { this.remove(); ava.textContent = (att.name || '?').slice(0, 1).toUpperCase(); };
        ava.appendChild(img);
      } else {
        ava.textContent = (att.name || '?').slice(0, 1).toUpperCase();
      }
      row.appendChild(ava);
      row.appendChild(el('div', { class: 'msg-att-profile-body' },
        el('div', { class: 'msg-att-pub' }, att.source === 'telegram' ? 'Профиль SOKOLENOK' : 'Профиль CS2'),
        el('div', { class: 'msg-att-title' }, att.name || 'Игрок'),
        el('div', { class: 'msg-att-preview' }, isSteamId(sid) ? `Steam ID: ${sid}` : 'Telegram-пользователь на сайте'),
        el('div', { class: 'msg-att-cta' }, 'Открыть профиль →')
      ));
      card.appendChild(row);
      return card;
    }
    if (att.type === 'reply') {
      const card = el('div', { class: 'msg-att msg-att-reply' });
      card.appendChild(el('div', { class: 'msg-att-author' }, '↩ ' + (att.author_name || 'Сообщение')));
      if (att.text_preview) card.appendChild(el('div', { class: 'msg-att-preview' }, att.text_preview));
      return card;
    }
    if (att.type === 'forward') {
      const card = el('div', { class: 'msg-att msg-att-forward' });
      card.appendChild(el('div', { class: 'msg-att-author' }, '↪ Переслано от ' + (att.author_name || 'неизвестно')));
      if (att.text_preview) card.appendChild(el('div', { class: 'msg-att-preview' }, att.text_preview));
      return card;
    }
    return null;
  }

  function paintThread(r) {
    const right = $('#msgr-right');
    right.innerHTML = '';
    const o = r.other;
    state.lastMsgId = 0;
    state.lastDate = null;

    // Header
    right.appendChild(el('div', { class: 'msgr-thread-h' },
      el('button', { class: 'msgr-back', type: 'button', 'aria-label': 'Назад',
        onclick: () => {
          document.body.classList.remove('msgr-thread-open');
          state.activeOther = null;
          tellServiceWorkerActiveMessagePeer(null);
          try { history.replaceState(history.state, '', '/messages'); } catch (_) {}
          renderLeft();
        },
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' }),
      avatarEl(o.avatar, o.name, 'msgr-avatar'),
      el('div', { class: 'msgr-thread-h-info' },
        el('a', { class: 'msgr-thread-name', href: `/lookup?steamid=${encId(o.steam_id)}` }, o.name),
        el('div', { class: 'msgr-thread-presence', id: 'msgr-thread-presence' }, '')
      ),
      el('div', { class: 'msgr-thread-actions' },
        el('button', { class: 'icon-btn', title: 'Заблокировать', type: 'button',
          onclick: async () => {
            if (!confirm(`Заблокировать ${o.name}? Переписка и дружба будут разорваны.`)) return;
            await api.block(o.steam_id); toast.ok('Пользователь заблокирован');
            state.activeOther = null;
            $('#msgr-right').innerHTML = '<div class="msgr-empty"><div class="msgr-empty-title">Пользователь заблокирован</div></div>';
            renderLeft();
          },
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>' })
      )
    ));

    // Messages scroll area (empty; filled by renderMessages)
    right.appendChild(el('div', { class: 'msgr-thread-scroll', id: 'msgr-thread-scroll' }));
    state.threadFriend = r.friend;
    renderThreadResponse(r);

    // Composer is shown if the user can write to this peer. Friends — always.
    // Moderators/admins — to anyone, for support replies. Otherwise locked.
    const canWrite = r.friend || !!(window.__me?.is_admin);
    if (canWrite) {
      const draftKey = `sok:draft:${me?.steamid || 'a'}:${o.steam_id}`;
      const input = el('textarea', { class: 'msgr-input', rows: '1', placeholder: 'Сообщение…', maxlength: '2000' });
      try { input.value = localStorage.getItem(draftKey) || ''; } catch (_) {}
      const persistDraft = () => { try { localStorage.setItem(draftKey, input.value); } catch (_) {} };
      const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch (_) {} };

      // Reply bar shown above input when replying
      const replyBar = el('div', { class: 'msgr-reply-bar', style: { display: 'none' } });
      const setReplyTo = (msgId, msgText, authorName) => {
        state.replyToId = msgId || null;
        if (!msgId) { replyBar.style.display = 'none'; replyBar.innerHTML = ''; return; }
        replyBar.style.display = '';
        replyBar.innerHTML = '';
        replyBar.appendChild(el('div', { class: 'msgr-reply-line' }));
        replyBar.appendChild(el('div', { class: 'msgr-reply-body' },
          el('div', { class: 'msgr-reply-author' }, '↩ Ответ ' + (authorName ? ('— ' + authorName) : '')),
          el('div', { class: 'msgr-reply-text' }, (msgText || '').slice(0, 120))
        ));
        replyBar.appendChild(el('button', { class: 'msgr-reply-x', type: 'button',
          onclick: () => setReplyTo(null), html: '&times;' }));
        input.focus();
      };

      const send = async () => {
        const text = input.value.trim();
        const replyId = state.replyToId;
        if (!text && !replyId) return;
        input.value = ''; input.style.height = 'auto'; clearDraft();
        const attachment = replyId ? { type: 'reply', message_id: replyId } : null;
        setReplyTo(null);
        const res = await api.sendMessage(o.steam_id, text, attachment).catch(() => ({ ok: false }));
        if (res.ok && res.message) {
          renderMessages([res.message]);
          const cachedThread = state.threadCache.get(o.steam_id);
          if (cachedThread) {
            cachedThread.messages = [...(cachedThread.messages || []), res.message];
            state.threadCache.set(o.steam_id, cachedThread);
          }
          state.convos = null;
          renderLeft({ silent: true, force: true });
        } else {
          toast.err(res.error === 'not-friends' ? 'Вы больше не друзья' : res.error === 'blocked' ? 'Недоступно' : 'Не отправлено');
          input.value = text; persistDraft();
        }
      };
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
        persistDraft();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

      const composer = el('div', { class: 'msgr-composer-wrap' },
        replyBar,
        el('div', { class: 'msgr-composer' },
          input,
          el('button', { class: 'msgr-send', type: 'button', onclick: send,
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' })
        )
      );
      right.appendChild(composer);

      // Delegate clicks on message action buttons (Reply / Forward) — desktop hover buttons
      const scrollEl = $('#msgr-thread-scroll');
      if (scrollEl) {
        scrollEl.addEventListener('click', (e) => {
          const btn = e.target.closest('.msgr-bubble-act');
          if (!btn) return;
          const mid = parseInt(btn.dataset.mid, 10);
          if (!Number.isFinite(mid)) return;
          const act = btn.dataset.act;
          const row = btn.closest('.msgr-bubble-row');
          const textEl = row?.querySelector('.msgr-bubble-text');
          const preview = textEl ? textEl.textContent : '';
          const isMine = row?.classList.contains('me');
          const authorName = isMine ? 'вам' : o.name;
          if (act === 'reply') setReplyTo(mid, preview, authorName);
          else if (act === 'forward') openForwardPicker(mid);
          else if (act === 'react') {
            const rect = btn.getBoundingClientRect();
            openMessageActionMenu(rect.left, rect.top, {
              onReply: () => setReplyTo(mid, preview, authorName),
              onForward: () => openForwardPicker(mid),
              onReact: async (emoji) => {
                const r = await api.reactToMessage(mid, emoji).catch(() => ({ ok: false }));
                if (r.ok) window.__updateBubbleReactions?.(row, r.reactions);
              },
              onDelete: isMine ? async () => {
                if (!confirm('Удалить это сообщение?')) return;
                const r = await api.deleteMessage(mid).catch(() => ({ ok: false }));
                if (r.ok) {
                  const bubble = row.querySelector('.msgr-bubble');
                  if (bubble) {
                    bubble.innerHTML = '';
                    bubble.appendChild(el('div', { class: 'msgr-bubble-text msgr-deleted' }, '🗑 Сообщение удалено'));
                  }
                } else toast.err('Не удалось удалить');
              } : null
            });
          }
        });

        // Long-press on bubble → action menu (mobile)
        let pressTimer = null;
        let pressedRow = null;
        let pressX = 0, pressY = 0;
        const startPress = (e, row) => {
          if (pressTimer) clearTimeout(pressTimer);
          pressedRow = row;
          const touch = e.touches ? e.touches[0] : e;
          pressX = touch.clientX; pressY = touch.clientY;
          pressTimer = setTimeout(() => {
            if (!pressedRow) return;
            const mid = parseInt(pressedRow.dataset.mid, 10);
            if (!Number.isFinite(mid)) return;
            // haptic feedback
            try { navigator.vibrate?.(20); } catch (_) {}
            const textEl = pressedRow.querySelector('.msgr-bubble-text');
            const preview = textEl ? textEl.textContent : '';
            const isMine = pressedRow.classList.contains('me');
            const authorName = isMine ? 'вам' : o.name;
            openMessageActionMenu(pressX, pressY, {
              onReply: () => setReplyTo(mid, preview, authorName),
              onForward: () => openForwardPicker(mid),
              onReact: async (emoji) => {
                const r = await api.reactToMessage(mid, emoji).catch(() => ({ ok: false }));
                if (r.ok) window.__updateBubbleReactions?.(pressedRow, r.reactions);
              },
              onDelete: isMine ? async () => {
                if (!confirm('Удалить это сообщение?')) return;
                const r = await api.deleteMessage(mid).catch(() => ({ ok: false }));
                if (r.ok) {
                  const bubble = pressedRow.querySelector('.msgr-bubble');
                  if (bubble) {
                    bubble.innerHTML = '';
                    bubble.appendChild(el('div', { class: 'msgr-bubble-text msgr-deleted' }, '🗑 Сообщение удалено'));
                  }
                } else toast.err('Не удалось удалить');
              } : null
            });
          }, 450);
        };
        const cancelPress = () => {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
          pressedRow = null;
        };
        const onMove = (e) => {
          if (!pressTimer) return;
          const t = e.touches ? e.touches[0] : e;
          if (Math.abs(t.clientX - pressX) > 10 || Math.abs(t.clientY - pressY) > 10) cancelPress();
        };
        scrollEl.addEventListener('touchstart', (e) => {
          const row = e.target.closest('.msgr-bubble-row');
          if (row) startPress(e, row);
        }, { passive: true });
        scrollEl.addEventListener('touchmove', onMove, { passive: true });
        scrollEl.addEventListener('touchend', cancelPress);
        scrollEl.addEventListener('touchcancel', cancelPress);
      }

      requestAnimationFrame(() => {
        if (window.matchMedia?.('(min-width: 761px)').matches) input.focus();
        if (input.value) { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; }
      });
    } else {
      right.appendChild(el('div', { class: 'msgr-composer-locked' },
        window.__me?.is_admin
          ? 'Этот игрок недоступен для переписки.'
          : 'Вы не друзья — переписка недоступна. Добавьте игрока в друзья на странице профиля.'));
    }

    // scroll to bottom on initial paint
    requestAnimationFrame(() => { const s = $('#msgr-thread-scroll'); if (s) s.scrollTop = s.scrollHeight; });
  }

  // Initial load; if URL has ?to=steamid, open that thread
  await renderLeft();
  const toId = new URLSearchParams(location.search).get('to');
  if (toId && isSiteUserId(toId)) openThread(toId);

  // Hybrid realtime: WebSocket pushes deliver new messages instantly; polling
  // remains as a slow safety net (and as the only path when WS is blocked).
  // Polling backs off to 15s while WS is healthy, returns to 3s if WS dies.
  function tick() {
    if (document.hidden) return;
    if (state.activeOther) {
      api.messages(state.activeOther).then(r => {
        if (!r.ok) return;
        cacheActiveThreadResponse(r);
        if ($('#msgr-thread-scroll')) renderThreadResponse(r);
      }).catch(() => {});
      loadThreadPresence(state.activeOther);
    }
    refreshUnreadBadge();
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    const interval = window.__wsAlive ? 25000 : 8000;
    state.pollTimer = setInterval(tick, interval);
  }
  schedulePoll();
  window.addEventListener('sok:ws:open', schedulePoll);
  window.addEventListener('sok:ws:close', schedulePoll);

  // Instant refresh when a message arrives in the currently-open thread.
  // For other threads, the global badge listener has already bumped the counter;
  // the left rail will pick it up on its next render.
  window.addEventListener('sok:ws', (ev) => {
    const m = ev.detail;
    if (!m) return;
    if (m.type === 'message:new' && state.activeOther && m.message?.peer === state.activeOther) {
      renderMessages([m.message]);
      appendMessageToThreadCache(state.activeOther, m.message);
      api.messages(state.activeOther).then(r => {
        if (!r.ok) return;
        cacheActiveThreadResponse(r);
        if ($('#msgr-thread-scroll')) renderThreadResponse(r);
      }).catch(() => {});
    } else if (m.type === 'message:sent' && state.activeOther && m.message?.peer === state.activeOther) {
      renderMessages([m.message]);
      appendMessageToThreadCache(state.activeOther, m.message);
      // Sent from another tab — keep this tab in sync
      api.messages(state.activeOther).then(r => {
        if (!r.ok) return;
        cacheActiveThreadResponse(r);
        if ($('#msgr-thread-scroll')) renderThreadResponse(r);
      }).catch(() => {});
    } else if (m.type === 'message:read' && state.activeOther === m.by) {
      markOutgoingSeen();
      // The other party just read our messages — repaint to show read receipts
      if ($('#msgr-thread-scroll')) {
        api.messages(state.activeOther).then(r => {
          if (r.ok) {
            cacheActiveThreadResponse(r);
            renderThreadResponse(r);
          }
        }).catch(() => {});
      }
    } else if (m.type === 'message:reaction') {
      // Reaction toggled by other party — update just that one bubble's
      // chips in place. No full thread re-render: avoids scroll jitter
      // and keeps reactions snappy.
      if (m.msg_id != null) {
        const row = document.querySelector(`.msgr-bubble-row[data-mid="${m.msg_id}"]`);
        if (row) window.__updateBubbleReactions?.(row, m.reactions || {});
      }
    } else if (m.type === 'message:new') {
      // Inbox refresh — left rail conversation list shows latest message preview
      renderLeft({ silent: true, force: true }).catch(() => {});
    }
  });
}

function avatarEl(src, name, cls) {
  // Wrap in positioned container so we can overlay a presence dot
  const outer = el('div', { class: 'avatar-wrap ' + (cls || 'msgr-avatar') });
  const wrap = el('div', { class: 'avatar-inner' });
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy' });
    img.onerror = function() { this.remove(); wrap.textContent = (name || '?').slice(0, 1).toUpperCase(); };
    wrap.appendChild(img);
  } else {
    wrap.textContent = (name || '?').slice(0, 1).toUpperCase();
  }
  outer.appendChild(wrap);
  return outer;
}
// Add or update a small presence dot on an avatar produced by avatarEl
function setAvatarPresence(avatarNode, presence) {
  if (!avatarNode) return;
  // Remove any old dot
  const old = avatarNode.querySelector(':scope > .presence-dot'); if (old) old.remove();
  const state = presenceState(presence);
  if (state === 'offline') return;
  avatarNode.appendChild(el('span', {
    class: 'presence-dot presence-' + state + ' avatar-dot',
    title: presenceLabel(presence)
  }));
}
function msgTime(iso) {
  const d = new Date(iso); return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function msgDateLabel(iso) {
  const d = new Date(iso); const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ============ page: admin ============
async function pageAdmin() {
  const me = await renderTopbar('admin');
  const gate = $('#admin-gate');
  const bodyEl = $('#admin-body');

  if (!me.logged_in || !me.is_admin) {
    gate.innerHTML = '';
    gate.appendChild(emptyCard('Доступ запрещён',
      'Эта страница доступна только администраторам.', '🔒'));
    return;
  }
  gate.style.display = 'none';
  bodyEl.style.display = '';

  // Moderators tab is superadmin-only
  if (me.is_superadmin) { const t = $('#tab-moderators'); if (t) t.style.display = ''; }
  if (me.is_superadmin) { const t = $('#tab-roles'); if (t) t.style.display = ''; }

  // Stats
  try {
    const s = await api.admin.stats();
    if (s.ok) paintAdminStats(s.stats);
  } catch (_) {}

  const tabs = $('#admin-tabs');
  const panel = $('#admin-panel');
  const load = async (tab) => {
    panel.innerHTML = '<div class="card"><div class="loading-inline"><div class="spinner sm"></div>Загрузка…</div></div>';
    if (tab === 'reports') return paintAdminReports(panel);
    if (tab === 'bans') return paintAdminBans(panel);
    if (tab === 'publics') return paintAdminPublics(panel);
    if (tab === 'posts') return paintAdminPosts(panel);
    if (tab === 'analytics') return paintAdminAnalytics(panel);
    if (tab === 'moderators') return paintAdminModerators(panel);
    if (tab === 'roles') return paintAdminRoles(panel);
    if (tab === 'tools') return paintAdminTools(panel);
  };
  for (const btn of tabs.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => {
      for (const b of tabs.querySelectorAll('.tab')) b.classList.remove('active');
      btn.classList.add('active');
      load(btn.dataset.tab);
    });
  }
  load('reports');
}

async function paintAdminModerators(panel) {
  const r = await api.admin.moderators().catch(() => ({ ok: false, moderators: [] }));
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Модераторы'));
  card.appendChild(el('div', { class: 'admin-row-sub', style: { marginBottom: '12px' } },
    'Модераторы могут банить, удалять контент и обрабатывать жалобы, но не могут назначать других модераторов. Назначать и снимать можете только вы.'));
  if (!r.moderators?.length) {
    card.appendChild(el('div', { class: 'admin-empty' }, 'Модераторов пока нет.'));
  } else {
    for (const m of r.moderators) {
      card.appendChild(el('div', { class: 'admin-row' },
        el('div', { class: 'admin-row-main' },
          el('div', { class: 'admin-row-title' }, el('a', { href: `/lookup?steamid=${encId(m.steam_id)}` }, m.name || m.steam_id)),
          el('div', { class: 'admin-row-sub' }, 'Назначен ', relDate(m.created_at))),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { if (confirm('Снять модератора?')) { await api.admin.removeModerator(m.steam_id); toast.ok('Снят'); paintAdminModerators(panel); } } }, 'Снять'))
      ));
    }
  }
  const input = el('input', { class: 'admin-input', placeholder: 'SteamID, ссылка или ник Steam' });
  card.appendChild(el('div', { class: 'admin-manual' },
    input,
    el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      const id = await api.resolveAny(input.value);
      if (!id) { toast.warn('Не нашли такого игрока'); return; }
      const res = await api.admin.addModerator(id);
      if (res.ok) { toast.ok('Модератор назначен'); paintAdminModerators(panel); }
      else toast.err('Ошибка');
    } }, 'Назначить')
  ));
  panel.appendChild(card);
}

const ROLE_COLORS = [
  { key: 'gold',   label: 'Золотой' },
  { key: 'green',  label: 'Зелёный' },
  { key: 'blue',   label: 'Синий' },
  { key: 'red',    label: 'Красный' },
  { key: 'purple', label: 'Фиолетовый' },
  { key: 'orange', label: 'Оранжевый' },
  { key: 'cyan',   label: 'Бирюзовый' },
  { key: 'gray',   label: 'Серый' }
];

async function paintAdminRoles(panel) {
  panel.innerHTML = '';
  const top = el('div', { class: 'card' },
    el('div', { class: 'card-eyebrow' }, 'Команда SOKOLENOK — роли'),
    el('div', { class: 'admin-row-sub', style: { marginBottom: '12px' } },
      'Создавайте роли с любым названием и цветом. Назначайте людей в роли — рядом с их ником будет виден бейдж.'),
    (function () {
      const nameI = el('input', { class: 'admin-input', placeholder: 'Название роли (например, "Администратор")', maxlength: '32' });
      const colorSel = el('select', { class: 'admin-input' });
      for (const c of ROLE_COLORS) colorSel.appendChild(el('option', { value: c.key }, c.label));
      colorSel.value = 'green';
      return el('div', { class: 'admin-manual' },
        nameI, colorSel,
        el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
          const name = nameI.value.trim();
          if (name.length < 2) { toast.warn('Минимум 2 символа'); return; }
          const r = await api.admin.createRole({ name, color: colorSel.value }).catch(() => ({ ok: false }));
          if (r.ok) { toast.ok('Роль создана'); nameI.value = ''; paintAdminRoles(panel); }
          else toast.err('Ошибка');
        } }, '+ Создать роль')
      );
    })()
  );
  panel.appendChild(top);

  const r = await api.admin.roles().catch(() => ({ ok: false, roles: [] }));
  for (const role of (r.roles || [])) {
    const card = el('div', { class: 'card role-admin-card' });
    const headRow = el('div', { class: 'role-admin-head' },
      roleBadge({ name: role.name, color: role.color }),
      el('div', { class: 'role-admin-meta' }, role.members.length + ' ' + plural(role.members.length, ['участник', 'участника', 'участников'])),
      el('div', { class: 'role-admin-actions' },
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openRoleEditModal(role, panel) }, 'Изменить'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', style: { color: 'var(--red)' }, onclick: async () => {
          if (!confirm(`Удалить роль "${role.name}"? Все назначения этой роли будут сняты.`)) return;
          const res = await api.admin.deleteRole(role.id).catch(() => ({ ok: false }));
          if (res.ok) { toast.ok('Удалено'); paintAdminRoles(panel); }
          else toast.err('Ошибка');
        } }, 'Удалить')
      )
    );
    card.appendChild(headRow);

    if (role.members.length) {
      const list = el('div', { class: 'role-members-list' });
      for (const m of role.members) {
        list.appendChild(el('div', { class: 'role-member' },
          el('a', { class: 'role-member-link', href: `/lookup?steamid=${encId(m.steam_id)}` }, m.name || m.steam_id),
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
            if (!confirm('Снять роль с этого игрока?')) return;
            await api.admin.removeRoleMember(role.id, m.steam_id);
            toast.ok('Снято'); paintAdminRoles(panel);
          } }, 'Убрать')
        ));
      }
      card.appendChild(list);
    } else {
      card.appendChild(el('div', { class: 'role-empty' }, 'Пока никого. Добавьте первого участника ниже.'));
    }

    const addInput = el('input', { class: 'admin-input', placeholder: 'SteamID, ссылка или ник Steam' });
    card.appendChild(el('div', { class: 'admin-manual' },
      addInput,
      el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        const id = await api.resolveAny(addInput.value);
        if (!id) { toast.warn('Не нашли такого игрока'); return; }
        const res = await api.admin.addRoleMember(role.id, id).catch(() => ({ ok: false }));
        if (res.ok) { toast.ok('Добавлен'); paintAdminRoles(panel); }
        else toast.err('Ошибка');
      } }, '+ Добавить игрока')
    ));
    panel.appendChild(card);
  }
}

function openRoleEditModal(role, panel) {
  const nameI = el('input', { class: 'modal-input', value: role.name, maxlength: '32' });
  const colorSel = el('select', { class: 'modal-input' });
  for (const c of ROLE_COLORS) colorSel.appendChild(el('option', { value: c.key }, c.label));
  colorSel.value = role.color || 'green';
  const snap = JSON.stringify({ n: nameI.value, c: colorSel.value });
  openModal('Редактировать роль', [
    el('label', { class: 'modal-label' }, 'Название'), nameI,
    el('label', { class: 'modal-label' }, 'Цвет бейджа'), colorSel,
    el('div', { style: { marginTop: '8px' } }, 'Предпросмотр: ', roleBadge({ name: role.name, color: role.color }))
  ], async () => {
    const name = nameI.value.trim();
    if (name.length < 2) { toast.warn('Минимум 2 символа'); return false; }
    const r = await api.admin.updateRole(role.id, { name, color: colorSel.value }).catch(() => ({ ok: false }));
    if (r.ok) { toast.ok('Сохранено'); paintAdminRoles(panel); return true; }
    toast.err('Ошибка'); return false;
  }, 'Сохранить', { guard: true, snapshot: () => JSON.stringify({ n: nameI.value, c: colorSel.value }), initialSnapshot: snap });
}

// Russian noun plural helper: pick form based on count
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function paintAdminStats(s) {
  const root = $('#admin-stats');
  if (!root) return;
  root.innerHTML = '';
  const cards = [
    { label: 'Пользователи', val: s.users },
    { label: 'Открытых жалоб', val: s.open_reports, hot: s.open_reports > 0 },
    { label: 'Паблики', val: s.publics },
    { label: 'Посты', val: s.posts },
    { label: 'Сообщения', val: s.messages },
    { label: 'Оценки', val: s.reputations },
    { label: 'Баны', val: s.bans }
  ];
  for (const c of cards) {
    root.appendChild(el('div', { class: 'kpi-card' + (c.hot ? ' kpi-hot' : '') },
      el('div', { class: 'kpi-label' }, c.label),
      el('div', { class: 'kpi-val' }, String(c.val ?? 0))
    ));
  }
}

async function paintAdminReports(panel) {
  const r = await api.admin.reports('open').catch(() => ({ ok: false, reports: [] }));
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Открытые жалобы'));
  if (!r.reports?.length) {
    card.appendChild(el('div', { class: 'admin-empty' }, 'Жалоб нет 🎉'));
    panel.appendChild(card); return;
  }
  for (const rep of r.reports) {
    const isSupport = rep.target_type === 'support';
    card.appendChild(el('div', { class: 'admin-row' },
      el('div', { class: 'admin-row-main' },
        el('div', { class: 'admin-row-title' },
          isSupport
            ? el('span', { class: 'admin-tag', style: { background: 'var(--g-soft)', color: 'var(--g)', borderColor: 'var(--line-acc)' } }, 'поддержка')
            : el('span', { class: 'admin-tag' }, rep.target_type),
          isSupport ? '' : (' ' + rep.target_id)),
        el('div', { class: 'admin-row-sub' },
          'От: ', el('a', { href: `/lookup?steamid=${encId(rep.reporter_steam_id)}` }, rep.reporter_name || rep.reporter_steam_id),
          rep.reason ? ` · «${rep.reason}»` : '',
          ' · ', relDate(rep.created_at))
      ),
      el('div', { class: 'admin-row-actions' },
        isSupport ? el('a', { class: 'btn btn-sm', href: `/messages?to=${encId(rep.reporter_steam_id)}` }, 'Ответить') : null,
        (!isSupport && rep.target_type === 'user') ? el('button', { class: 'btn btn-sm', type: 'button',
          onclick: async () => { const reason = prompt('Причина бана:') || ''; await api.admin.ban(rep.target_id, reason); await api.admin.resolveReport(rep.id, 'resolved'); toast.ok('Забанен'); paintAdminReports(panel); } }, 'Забанить') : null,
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: async () => { await api.admin.resolveReport(rep.id, 'resolved'); toast.ok('Решено'); paintAdminReports(panel); } }, 'Решено'),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: async () => { await api.admin.resolveReport(rep.id, 'dismissed'); paintAdminReports(panel); } }, 'Отклонить')
      )
    ));
  }
  panel.appendChild(card);
}

async function paintAdminBans(panel) {
  const r = await api.admin.bans().catch(() => ({ ok: false, bans: [] }));
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Заблокированные пользователи'));
  if (!r.bans?.length) {
    card.appendChild(el('div', { class: 'admin-empty' }, 'Банов нет.'));
  } else {
    for (const b of r.bans) {
      card.appendChild(el('div', { class: 'admin-row' },
        el('div', { class: 'admin-row-main' },
          el('div', { class: 'admin-row-title' }, el('a', { href: `/lookup?steamid=${encId(b.steam_id)}` }, b.name || b.steam_id)),
          el('div', { class: 'admin-row-sub' }, (b.reason || 'без причины'), ' · ', relDate(b.created_at))
        ),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { await api.admin.unban(b.steam_id); toast.ok('Разбанен'); paintAdminBans(panel); } }, 'Разбанить'))
      ));
    }
  }
  // Manual ban by SteamID
  const banInput = el('input', { class: 'admin-input', placeholder: 'SteamID, ссылка или ник Steam' });
  card.appendChild(el('div', { class: 'admin-manual' },
    banInput,
    el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      const id = await api.resolveAny(banInput.value);
      if (!id) { toast.warn('Не нашли такого игрока'); return; }
      const reason = prompt('Причина бана:') || '';
      const res = await api.admin.ban(id, reason);
      if (res.ok) { toast.ok('Забанен'); paintAdminBans(panel); }
      else toast.err(res.error === 'cant-ban-admin' ? 'Нельзя забанить админа' : 'Ошибка');
    } }, 'Забанить')
  ));
  panel.appendChild(card);
}

async function paintAdminPublics(panel) {
  const r = await api.admin.publics().catch(() => ({ ok: false, publics: [] }));
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Паблики'));
  if (!r.publics?.length) {
    card.appendChild(el('div', { class: 'admin-empty' }, 'Пабликов пока нет.'));
  } else {
    for (const p of r.publics) {
      card.appendChild(el('div', { class: 'admin-row' },
        el('div', { class: 'admin-row-main' },
          el('div', { class: 'admin-row-title' }, p.name, p.verified ? ' ✓' : ''),
          el('div', { class: 'admin-row-sub' }, p.description || '—')
        ),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { await api.admin.verifyPublic(p.id, !p.verified); paintAdminPublics(panel); } }, p.verified ? 'Снять ✓' : 'Verify'),
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { if (confirm('Удалить паблик и все его посты?')) { await api.admin.deletePublic(p.id); toast.ok('Удалён'); paintAdminPublics(panel); } } }, 'Удалить')
        )
      ));
    }
  }
  panel.appendChild(card);
}


async function paintAdminAnalytics(panel) {
  const r = await api.admin.analytics(30).catch(() => ({ ok: false }));
  panel.innerHTML = '';
  if (!r.ok) { panel.appendChild(el('div', { class: 'card admin-empty' }, 'Не удалось загрузить аналитику.')); return; }
  const report = r.report || { totals: {}, sources: [] };
  const t = report.totals || {};
  const cards = el('div', { class: 'kpis k4' },
    adminKpi('Проверки профиля', t.lookup_success || 0),
    adminKpi('Показана цена', t.inventory_value_shown || 0),
    adminKpi('Входы Steam', t.steam_login_success || 0),
    adminKpi('Шеринги', t.profile_shared || 0)
  );
  panel.appendChild(cards);
  const sourceCard = el('div', { class: 'card', style: { marginTop: '16px' } }, el('div', { class: 'card-eyebrow' }, 'Источники за 30 дней'));
  if (!(report.sources || []).length) sourceCard.appendChild(el('div', { class: 'admin-empty' }, 'Событий ещё нет. Добавьте UTM-ссылку и сделайте тестовый переход.'));
  else for (const s of report.sources) sourceCard.appendChild(el('div', { class: 'admin-row' },
    el('div', { class: 'admin-row-main' }, el('div', { class: 'admin-row-title' }, s.source), el('div', { class: 'admin-row-sub' }, `${s.visits} визитов · ${s.lookups} проверок · ${s.logins} входов · ${s.shares} шерингов`))));
  panel.appendChild(sourceCard);
}
function adminKpi(label, value) { return el('div', { class: 'kpi' }, el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, String(value))); }

async function paintAdminPosts(panel) {
  const r = await api.admin.posts().catch(() => ({ ok: false, posts: [] }));
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Последние посты'));
  if (!r.posts?.length) {
    card.appendChild(el('div', { class: 'admin-empty' }, 'Постов пока нет.'));
  } else {
    for (const p of r.posts) {
      card.appendChild(el('div', { class: 'admin-row' },
        el('div', { class: 'admin-row-main' },
          el('div', { class: 'admin-row-title' }, p.title || '(без заголовка)'),
          el('div', { class: 'admin-row-sub' }, (p.body || '').slice(0, 120), ' · ', relDate(p.created_at))
        ),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { if (confirm('Удалить пост?')) { await api.admin.deletePost(p.id); toast.ok('Удалён'); paintAdminPosts(panel); } } }, 'Удалить'))
      ));
    }
  }
  panel.appendChild(card);
}

function paintAdminTools(panel) {
  panel.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Инструменты'));
  card.appendChild(el('div', { class: 'admin-tool' },
    el('div', { class: 'admin-row-title' }, 'Найти игрока'),
    el('div', { class: 'admin-row-sub' }, 'По никнейму, ссылке на профиль или SteamID.')
  ));
  card.appendChild(el('div', { class: 'admin-manual' },
    el('button', { class: 'btn btn-sm', type: 'button', onclick: openSearchModal }, 'Открыть поиск')
  ));
  panel.appendChild(card);
}

// ============ page: friends ============
async function pageFriends() {
  const me = await renderTopbar('friends');
  if (!me.logged_in) {
    toast.warn('Войдите, чтобы открыть друзей');
    setTimeout(() => location.replace('/'), 800);
    return;
  }
  const tabs = $('#friends-tabs');
  const body = $('#friends-body');
  let cur = 'friends';
  mountFriendsFinder(body, () => load(cur));
  mountSteamFriendsSuggestions(body, () => load(cur));

  const load = async (tab) => {
    cur = tab;
    body.innerHTML = '<div class="card"><div class="loading-inline"><div class="spinner sm"></div>Загрузка…</div></div>';
    if (tab === 'recommend') {
      const r = await api.recommendFriends().catch(() => ({ ok: false, recommendations: [] }));
      paintRecommendations(body, r.recommendations || []);
    } else if (tab === 'blocks') {
      const r = await api.blocks().catch(() => ({ ok: false, blocked: [] }));
      paintFriendsBlocks(body, r.blocked || [], () => load(cur));
    } else {
      const r = await api.friends().catch(() => ({ ok: false }));
      const arr = r[tab] || [];
      paintFriendsList(body, arr, tab, () => load(cur));
    }
  };
  for (const btn of tabs.querySelectorAll('.feed-tab')) {
    btn.addEventListener('click', () => {
      for (const b of tabs.querySelectorAll('.feed-tab')) b.classList.remove('active');
      btn.classList.add('active');
      load(btn.dataset.tab);
    });
  }
  load('friends');
}

function mountFriendsFinder(anchor, refresh) {
  if (!anchor || document.getElementById('friends-finder')) return;
  const panel = el('div', { class: 'card friends-finder', id: 'friends-finder' },
    el('div', { class: 'friends-finder-main' },
      el('div', { class: 'card-eyebrow' }, 'Найти игрока'),
      el('form', { class: 'friends-search-form' },
        el('input', { class: 'input friends-search-input', type: 'search', autocomplete: 'off',
          placeholder: 'Ник, SteamID, ссылка Steam или Telegram-профиль' }),
        el('button', { class: 'btn', type: 'submit' }, 'Найти')
      )
    ),
    el('div', { class: 'friends-search-results' })
  );
  anchor.parentElement?.insertBefore(panel, anchor);
  const form = panel.querySelector('form');
  const input = panel.querySelector('input');
  const results = panel.querySelector('.friends-search-results');
  const renderUser = async (u) => {
    const sid = u.steam_id || u.steamid;
    if (!sid) return;
    let status = 'none';
    try { status = (await api.friendStatus(sid))?.status || 'none'; } catch (_) {}
    const actions = el('div', { class: 'friend-row-actions' });
    if (window.__me?.steamid === sid) {
      actions.appendChild(el('a', { class: 'btn btn-sm btn-ghost', href: `/lookup?steamid=${encId(sid)}` }, 'Это вы'));
    } else if (status === 'friends') {
      actions.appendChild(el('a', { class: 'btn btn-sm', href: `/messages?to=${encId(sid)}` }, 'Написать'));
      actions.appendChild(el('a', { class: 'btn btn-sm btn-ghost', href: `/lookup?steamid=${encId(sid)}` }, 'Профиль'));
    } else if (status === 'outgoing') {
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: 'disabled' }, 'Заявка отправлена'));
    } else if (status === 'incoming') {
      actions.appendChild(el('button', { class: 'btn btn-sm', type: 'button',
        onclick: async () => { await api.friendAccept(sid); toast.ok('Заявка принята'); refresh?.(); form.dispatchEvent(new Event('submit', { cancelable: true })); } }, 'Принять'));
    } else {
      actions.appendChild(el('button', { class: 'btn btn-sm', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const r = await api.friendRequest(sid).catch(() => ({ ok: false }));
          if (r.ok) { toast.ok('Заявка отправлена'); btn.textContent = 'Заявка отправлена'; btn.classList.add('btn-ghost'); refresh?.(); }
          else { toast.err('Не удалось отправить'); btn.disabled = false; }
        } }, 'Добавить'));
      actions.appendChild(el('a', { class: 'btn btn-sm btn-ghost', href: `/lookup?steamid=${encId(sid)}` }, 'Профиль'));
    }
    results.appendChild(buildFriendRow({
      steam_id: sid,
      name: u.persona_name || u.name || sid,
      avatar: u.avatar || null
    }, actions, /^tg:\d+$/.test(sid) ? 'Telegram-пользователь' : 'Игрок SOKOLENOK'));
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    results.innerHTML = '<div class="loading-inline"><div class="spinner sm"></div>Ищем...</div>';
    const usersR = await api.request(`/api/search?kind=users&q=${encodeURIComponent(q)}`).catch(() => null);
    let users = usersR?.users || [];
    const direct = await api.resolveAny(q).catch(() => null);
    if (direct && !users.some(u => u.steam_id === direct)) {
      const pr = await api.profile(direct).catch(() => null);
      if (pr?.ok) users.unshift({
        steam_id: direct,
        persona_name: pr.profile?.personaname,
        avatar: pr.profile?.avatar || pr.profile?.avatarfull
      });
    }
    results.innerHTML = '';
    if (!users.length) {
      results.appendChild(el('div', { class: 'friends-search-empty' }, 'Пока никого не нашли. Попробуйте SteamID или ссылку на профиль.'));
      return;
    }
    for (const u of users.slice(0, 8)) await renderUser(u);
    decorateFriendPresence(results);
  });
}

async function mountSteamFriendsSuggestions(anchor, refresh) {
  if (!anchor || document.getElementById('steam-friends-suggest')) return;
  if (!isSteamId(window.__me?.steamid)) return;
  const r = await api.steamFriendsOnSite().catch(() => null);
  const arr = r?.ok ? (r.friends || []) : [];
  if (!arr.length) return;
  const card = el('div', { class: 'card steam-friends-suggest', id: 'steam-friends-suggest' },
    el('div', { class: 'steam-friends-head' },
      el('div', null,
        el('div', { class: 'card-eyebrow' }, 'Steam-друзья на SOKOLENOK'),
        el('div', { class: 'steam-friends-sub' }, 'Эти люди уже есть на сайте, но ещё не в друзьях здесь.')
      )
    )
  );
  for (const f of arr.slice(0, 8)) {
    const actions = el('div', { class: 'friend-row-actions' },
      el('button', { class: 'btn btn-sm', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const res = await api.friendRequest(f.steam_id).catch(() => ({ ok: false }));
          if (res.ok) {
            toast.ok('Заявка отправлена');
            btn.textContent = 'Заявка отправлена';
            btn.classList.add('btn-ghost');
            refresh?.();
          } else {
            toast.err('Не удалось');
            btn.disabled = false;
          }
        } }, 'Добавить'),
      el('a', { class: 'btn btn-sm btn-ghost', href: `/lookup?steamid=${encId(f.steam_id)}` }, 'Профиль')
    );
    card.appendChild(buildFriendRow(f, actions, 'Ваш Steam-друг'));
  }
  anchor.parentElement?.insertBefore(card, anchor);
  decorateFriendPresence(card);
}

function paintFriendsList(root, arr, tab, refresh) {
  root.innerHTML = '';
  if (!arr.length) {
    const empties = {
      friends: ['Пока нет друзей', 'Найдите игрока и отправьте заявку — он появится здесь после подтверждения.'],
      incoming: ['Заявок нет', 'Когда кто-то добавит вас, заявка появится здесь.'],
      outgoing: ['Отправленных заявок нет', 'Заявки, которые вы отправили, появятся тут.']
    };
    const [t, s] = empties[tab] || ['Пусто', ''];
    const action = tab === 'friends'
      ? { label: 'Найти игрока', onclick: () => document.querySelector('.friends-search-input')?.focus() }
      : null;
    root.appendChild(emptyCard(t, s, '👥', action));
    return;
  }
  const card = el('div', { class: 'card' });
  for (const f of arr) {
    const actions = el('div', { class: 'friend-row-actions' });
    if (tab === 'friends') {
      actions.appendChild(el('a', { class: 'btn btn-sm', href: `/messages?to=${encId(f.steam_id)}` }, 'Написать'));
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
        onclick: async () => { if (confirm(`Удалить ${f.name || 'игрока'} из друзей?`)) { await api.friendRemove(f.steam_id); toast.ok('Удалён'); refresh?.(); } } }, 'Удалить'));
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button', style: { color: 'var(--red)' },
        onclick: async () => { if (confirm(`Заблокировать ${f.name || 'игрока'}? Дружба будет разорвана.`)) { await api.block(f.steam_id); toast.ok('Заблокирован'); refresh?.(); } } }, 'В чёрный список'));
    } else if (tab === 'incoming') {
      actions.appendChild(el('button', { class: 'btn btn-sm', type: 'button',
        onclick: async () => { await api.friendAccept(f.steam_id); toast.ok('Заявка принята'); refresh?.(); } }, 'Принять'));
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
        onclick: async () => { await api.friendRemove(f.steam_id); refresh?.(); } }, 'Отклонить'));
    } else {
      actions.appendChild(el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
        onclick: async () => { await api.friendRemove(f.steam_id); refresh?.(); } }, 'Отменить'));
    }
    card.appendChild(buildFriendRow(f, actions));
  }
  root.appendChild(card);
  decorateFriendPresence(card);
}

function paintRecommendations(root, arr) {
  root.innerHTML = '';
  if (!arr.length) {
    root.appendChild(emptyCard('Пока нет подсказок по друзьям',
      'Когда у вас появятся друзья, SOKOLENOK покажет знакомых людей из их круга.', '✨',
      { label: 'Найти игрока', onclick: () => document.querySelector('.friends-search-input')?.focus() }));
    return;
  }
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Знакомые через друзей'));
  for (const f of arr) {
    const actions = el('div', { class: 'friend-row-actions' },
      el('button', { class: 'btn btn-sm', type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          const r = await api.friendRequest(f.steam_id).catch(() => ({ ok: false }));
          if (r.ok) { toast.ok('Заявка отправлена'); btn.textContent = 'Заявка отправлена'; btn.classList.add('btn-ghost'); }
          else { toast.err('Ошибка'); btn.disabled = false; }
        } }, 'Добавить в друзья'),
      el('a', { class: 'btn btn-sm btn-ghost', href: `/lookup?steamid=${encId(f.steam_id)}` }, 'Профиль')
    );
    card.appendChild(buildFriendRow(f, actions, `${f.mutuals} общ. ${f.mutuals === 1 ? 'друг' : 'друзей'}`));
  }
  root.appendChild(card);
}

function paintFriendsBlocks(root, arr, refresh) {
  root.innerHTML = '';
  if (!arr.length) {
    root.appendChild(emptyCard('Чёрный список пуст', 'Заблокированные не смогут писать и добавляться к вам.', '🚫'));
    return;
  }
  const card = el('div', { class: 'card' });
  for (const f of arr) {
    card.appendChild(buildFriendRow(f,
      el('div', { class: 'friend-row-actions' },
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: async () => { await api.unblock(f.steam_id); toast.ok('Разблокирован'); refresh?.(); } }, 'Разблокировать')
      )
    ));
  }
  root.appendChild(card);
}

function buildFriendRow(f, actionsNode, subText) {
  const ava = el('div', { class: 'friend-row-ava', 'data-sid': f.steam_id });
  if (f.avatar) {
    const img = el('img', { src: f.avatar, alt: '' });
    img.onerror = function() { this.remove(); ava.textContent = (f.name || '?').slice(0,1).toUpperCase(); };
    ava.appendChild(img);
  } else ava.textContent = (f.name || '?').slice(0,1).toUpperCase();
  return el('div', { class: 'friend-row' },
    ava,
    el('div', { class: 'friend-row-info' },
      el('a', { class: 'friend-row-name', href: `/lookup?steamid=${encId(f.steam_id)}` }, f.name || f.steam_id),
      subText ? el('div', { class: 'friend-row-sub' }, subText) : null
    ),
    actionsNode
  );
}

// Batch-load presence for all friend rows in a container
async function decorateFriendPresence(root) {
  const avas = Array.from(root.querySelectorAll('.friend-row-ava[data-sid]'));
  const ids = avas.map(a => a.dataset.sid).filter(Boolean);
  if (!ids.length) return;
  const r = await api.presence(ids).catch(() => null);
  if (!r?.ok) return;
  for (const av of avas) {
    const sid = av.dataset.sid;
    if (!sid || !r.presence[sid]) continue;
    const state = presenceState(r.presence[sid]);
    if (state === 'offline') continue;
    // Friend-row-ava already has position relative? if not, set it
    av.style.position = av.style.position || 'relative';
    av.appendChild(el('span', { class: 'presence-dot presence-' + state + ' avatar-dot',
      title: presenceLabel(r.presence[sid]) }));
  }
}

// ============ page: communities ============
async function pageNotifications() {
  const me = await renderTopbar('notifications');
  if (!me.logged_in) {
    toast.warn('Войдите чтобы посмотреть уведомления');
    setTimeout(() => location.replace('/'), 800);
    return;
  }
  const body = $('#notif-body');
  const r = await api.request('/api/notifications').catch(() => null);
  body.innerHTML = '';
  if (!r?.ok) {
    body.appendChild(emptyCard('Не удалось загрузить уведомления',
      'Похоже на временную сетевую ошибку. Обновите страницу или вернитесь к ленте.',
      '🔔',
      [
        { label: 'Обновить', onclick: () => location.reload() },
        { label: 'Открыть ленту', class: 'btn btn-sm btn-ghost', href: '/feed' }
      ]));
    return;
  }
  if (!r.notifications?.length) {
    body.appendChild(el('div', { class: 'card feed-empty' },
      el('div', { class: 'feed-empty-icon' }, '🔔'),
      el('div', { class: 'feed-empty-title' }, 'Уведомлений пока нет'),
      el('div', { class: 'feed-empty-desc' }, 'Здесь появятся заявки в друзья, ответы, реакции и важные события по вашему профилю.'),
      el('div', { class: 'feed-empty-actions' },
        el('a', { class: 'btn btn-sm', href: '/friends' }, 'Найти друзей'),
        el('a', { class: 'btn btn-sm btn-ghost', href: '/feed' }, 'Открыть ленту')
      )
    ));
    return;
  }
  const list = el('div', { class: 'notif-list' });
  for (const n of r.notifications) list.appendChild(buildNotificationRow(n));
  body.appendChild(list);
  // Now that we've delivered them, server marked them read — refresh badges
  refreshUnreadBadge();
}

function buildNotificationRow(n) {
  const actor = n.actor || {};
  const data = n.data || {};
  const actorName = publicUserName(actor, 'Telegram-пользователь');
  let icon = '🔔', text = '', href = '#';
  if (n.kind === 'post_like') {
    icon = '❤️';
    text = 'лайкнул(а) ваш пост';
    href = `/feed?public=${encodeURIComponent(data.public_id || '')}#post-${data.post_id || ''}`;
  } else if (n.kind === 'post_comment') {
    icon = '💬';
    text = 'прокомментировал(а) ваш пост';
    if (data.snippet) text += `: "${data.snippet.slice(0, 60)}${data.snippet.length > 60 ? '…' : ''}"`;
    href = `/feed?public=${encodeURIComponent(data.public_id || '')}#post-${data.post_id || ''}`;
  } else if (n.kind === 'subscribe') {
    icon = '👥';
    text = `подписался(ась) на ваше сообщество «${data.public_name || ''}»`;
    href = `/feed?public=${encodeURIComponent(data.public_id || '')}`;
  } else if (n.kind === 'friend_request') {
    icon = '➕';
    text = 'отправил(а) заявку в друзья';
    href = '/friends';
  } else if (n.kind === 'friend_accept') {
    icon = '✓';
    text = 'принял(а) вашу заявку в друзья';
    href = `/lookup?steamid=${encId(actor.steam_id || '')}`;
  } else {
    text = 'выполнил(а) действие';
  }

  const row = el('a', { class: 'notif-row' + (n.read ? '' : ' unread'), href });

  const ava = el('div', { class: 'notif-ava' });
  if (actor.avatar) {
    const img = el('img', { src: actor.avatar, alt: '' });
    img.onerror = function() { this.remove(); ava.textContent = actorName.slice(0, 1).toUpperCase(); };
    ava.appendChild(img);
  } else ava.textContent = actorName.slice(0, 1).toUpperCase();
  row.appendChild(ava);

  const body = el('div', { class: 'notif-body' });
  const head = el('div', { class: 'notif-head' },
    el('strong', { class: 'notif-actor' }, actorName),
    actor.role ? roleBadge(actor.role) : null,
    el('span', { class: 'notif-icon' }, ' ' + icon),
    el('span', { class: 'notif-text' }, ' ' + text)
  );
  body.appendChild(head);
  if (data.post_title) body.appendChild(el('div', { class: 'notif-context' }, '↳ ' + data.post_title));
  body.appendChild(el('div', { class: 'notif-date' }, n.created_at ? relDate(n.created_at) : ''));
  row.appendChild(body);

  if (!n.read) row.appendChild(el('div', { class: 'notif-dot' }));

  return row;
}

async function pageCommunities() {
  const me = await renderTopbar('communities');
  if (!me.logged_in) {
    toast.warn('Войдите, чтобы открыть сообщества');
    setTimeout(() => location.replace('/'), 800);
    return;
  }
  const tabs = $('#cm-tabs');
  const body = $('#cm-body');
  const search = $('#cm-search');
  const state = { tab: 'all', q: '', publics: [], subs: [] };

  const render = () => {
    body.innerHTML = '';
    const q = state.q.trim().toLowerCase();
    let list = state.publics.slice();
    if (state.tab === 'subs') list = list.filter(p => p.subscribed);
    else if (state.tab === 'mine') list = list.filter(p => p.is_owner);
    if (q) list = list.filter(p => (p.name || '').toLowerCase().includes(q)
      || (p.description || '').toLowerCase().includes(q));

    if (!list.length) {
      const empties = {
        all: ['Сообществ пока нет', 'Создайте первое — оно появится здесь и в ленте.'],
        subs: ['Вы ни на кого не подписаны', 'Откройте вкладку «Все» и подпишитесь.'],
        mine: ['У вас пока нет сообществ', 'Нажмите «Создать» сверху.']
      };
      const [t, s] = empties[state.tab];
      const actions = state.tab === 'subs'
        ? [
            { label: 'Показать все', onclick: () => { state.tab = 'all'; render(); } },
            { label: 'Открыть ленту', class: 'btn btn-sm btn-ghost', href: '/feed' }
          ]
        : [
            { label: 'Создать', onclick: () => openCreatePublicModal() },
            { label: 'Открыть ленту', class: 'btn btn-sm btn-ghost', href: '/feed' }
          ];
      body.appendChild(emptyCard(t, s, '👥', actions));
    } else {
      const grid = el('div', { class: 'cm-grid' });
      for (const p of list) grid.appendChild(buildCommunityCard(p));
      body.appendChild(grid);
    }

    // Recommendations: only on All tab, when no search active, and there are some
    if (state.tab === 'all' && !q && state.recommendations?.length) {
      body.appendChild(el('div', { class: 'cm-recommend-h' }, '👥 Подписки ваших друзей'));
      const grid = el('div', { class: 'cm-grid' });
      for (const r of state.recommendations) grid.appendChild(buildRecommendedCard(r));
      body.appendChild(grid);
    }
  };

  // Toolbar: "Create" button + search wiring
  const createBtn = el('button', { class: 'btn btn-sm cm-create', type: 'button',
    onclick: () => openCreatePublicModal(),
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Создать сообщество' });
  search.parentElement.insertBefore(createBtn, search.parentElement.firstChild);
  // Wrap search row
  search.parentElement.style.display = 'flex';
  search.parentElement.style.gap = '8px';
  search.parentElement.style.flexWrap = 'wrap';
  search.style.flex = '1';
  search.style.minWidth = '180px';

  search.addEventListener('input', () => { state.q = search.value; render(); });
  for (const btn of tabs.querySelectorAll('.feed-tab')) {
    btn.addEventListener('click', () => {
      for (const b of tabs.querySelectorAll('.feed-tab')) b.classList.remove('active');
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      render();
    });
  }

  // Load
  const r = await api.publics().catch(() => ({ ok: false, publics: [] }));
  state.publics = r.publics || [];
  render();
  // Recommendations are best-effort, fetched in background
  api.recommendCommunities().then(res => {
    if (res?.ok) { state.recommendations = res.recommendations || []; render(); }
  }).catch(() => {});
}

// Card variant for recommended community (shows how many friends are subscribed)
function buildRecommendedCard(p) {
  const subBtn = el('button', { class: 'btn btn-sm', type: 'button',
    onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      const btn = e.currentTarget; btn.disabled = true;
      const r = await api.subscribePublic(p.id);
      if (r?.ok) { btn.textContent = '✓'; btn.classList.add('btn-ghost'); }
      btn.disabled = false;
    }
  }, 'Подписаться');

  const ava = el('div', { class: 'cm-ava' + (p.verified ? ' official' : '') });
  if (p.avatar) {
    const img = el('img', { src: p.avatar, alt: '' });
    img.onerror = function() { this.remove(); ava.textContent = (p.name || '?').slice(0, 1).toUpperCase(); };
    ava.appendChild(img);
  } else ava.textContent = (p.name || '?').slice(0, 1).toUpperCase();

  return el('a', { class: 'cm-card', href: `/feed?public=${encodeURIComponent(p.id)}` },
    ava,
    el('div', { class: 'cm-info' },
      el('div', { class: 'cm-name' }, p.name),
      el('div', { class: 'cm-desc' }, p.description || ''),
      el('div', { class: 'cm-recommend-info' },
        `👤 ${p.friend_subscribers} ${plural(p.friend_subscribers, ['друг подписан', 'друга подписаны', 'друзей подписаны'])}` +
        (p.total_subscribers ? ` · ${p.total_subscribers} всего` : '')
      )
    ),
    subBtn
  );
}

function buildCommunityCard(p) {
  const subBtn = el('button', {
    class: 'btn btn-sm' + (p.subscribed ? ' btn-ghost' : ''), type: 'button',
    onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      const btn = e.currentTarget; btn.disabled = true;
      const r = p.subscribed ? await api.unsubscribePublic(p.id) : await api.subscribePublic(p.id);
      if (r?.ok) {
        p.subscribed = r.subscribed;
        btn.textContent = p.subscribed ? 'Отписаться' : 'Подписаться';
        btn.classList.toggle('btn-ghost', p.subscribed);
      }
      btn.disabled = false;
    }
  }, p.subscribed ? 'Отписаться' : 'Подписаться');

  const ava = el('div', { class: 'cm-ava' + (p.verified ? ' official' : '') });
  if (p.avatar) {
    const img = el('img', { src: p.avatar, alt: '' });
    img.onerror = function() { this.remove(); ava.textContent = (p.name || '?').slice(0,1).toUpperCase(); };
    ava.appendChild(img);
  } else ava.textContent = (p.name || '?').slice(0,1).toUpperCase();

  return el('a', { class: 'cm-card', href: `/feed?public=${encodeURIComponent(p.id)}` },
    ava,
    el('div', { class: 'cm-info' },
      el('div', { class: 'cm-name' }, p.name,
        p.verified ? el('span', { class: 'feed-verified', title: 'Проверено', html:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' }) : null,
        p.is_owner ? el('span', { class: 'feed-owner-tag' }, 'мой') : null),
      p.description ? el('div', { class: 'cm-desc' }, p.description) : null
    ),
    p.is_owner ? null : subBtn
  );
}

// ============ page: me (mobile hub: profile + menu) ============
async function pageMe() {
  const me = await renderTopbar('me');
  const root = $('#me-root');
  if (!me.logged_in) {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'card', style: { textAlign: 'center', padding: '40px 20px' } },
      el('div', { style: { marginBottom: '16px', color: 'var(--dim)' } }, 'Войдите, чтобы открыть профиль'),
      el('a', { class: 'btn', href: '/auth/steam', onclick: steamLogin }, 'Войти через Steam')));
    return;
  }
  root.innerHTML = '';

  const p = me.profile || {};
  const avatar = p.avatarfull || p.avatar;

  // Profile card
  const profCard = el('div', { class: 'card me-prof anim-rise' },
    el('div', { class: 'me-prof-top' },
      (function () {
        const a = el('div', { class: 'me-avatar' });
        if (avatar) { const img = el('img', { src: avatar, alt: '' }); img.onerror = function(){ this.remove(); a.textContent = (p.personaname||'?').slice(0,1); }; a.appendChild(img); }
        else a.textContent = (p.personaname || '?').slice(0, 1).toUpperCase();
        return a;
      })(),
      el('div', { class: 'me-prof-info' },
        el('div', { class: 'me-prof-name' }, p.personaname || 'Игрок'),
        el('div', { class: 'me-prof-id' }, 'ID: ' + (me.steamid || '').slice(-12))
      )
    ),
    el('a', { class: 'btn btn-full', href: `/lookup?steamid=${encId(me.steamid)}`, style: { marginTop: '14px' } }, 'Открыть мой профиль')
  );
  root.appendChild(profCard);

  // Menu items
  const items = [
    { href: '/friends', label: 'Друзья', icon: 'users', desc: 'Список, заявки, подсказки и чёрный список' },
    { href: '/communities', label: 'Сообщества', icon: 'grid', desc: 'Ваши и подписки' },
    { action: openSearchModal, label: 'Найти игрока', icon: 'help', desc: 'По никнейму, ссылке или SteamID' },
    { action: openSupportModal, label: 'Связь с поддержкой', icon: 'help', desc: 'Написать администратору' },
    { href: '/settings', label: 'Настройки', icon: 'settings', desc: 'Валюта, Faceit, аккаунт' }
  ];
  if (me.is_admin) items.push({ href: '/admin', label: 'Админка', icon: 'shield', desc: 'Модерация и статистика', accent: true });

  const menu = el('div', { class: 'card me-menu anim-rise', style: { animationDelay: '0.05s' } });
  for (const it of items) {
    const node = el(it.action ? 'button' : 'a',
      Object.assign({ class: 'me-menu-item' + (it.accent ? ' accent' : '') },
        it.action ? { type: 'button', onclick: it.action } : { href: it.href }),
      el('span', { class: 'me-menu-ico' }, navIcon(it.icon)),
      el('span', { class: 'me-menu-text' },
        el('span', { class: 'me-menu-label' }, it.label),
        el('span', { class: 'me-menu-desc' }, it.desc)),
      el('span', { class: 'me-menu-arrow', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' })
    );
    menu.appendChild(node);
  }
  root.appendChild(menu);

  // Legal + logout
  const foot = el('div', { class: 'card me-menu anim-rise', style: { animationDelay: '0.1s' } });
  for (const it of [
    { href: '/privacy', label: 'Конфиденциальность' },
    { href: '/terms', label: 'Соглашение' },
    { href: '/rules', label: 'Правила сообщества' }
  ]) {
    foot.appendChild(el('a', { class: 'me-menu-item small', href: it.href },
      el('span', { class: 'me-menu-text' }, el('span', { class: 'me-menu-label' }, it.label)),
      el('span', { class: 'me-menu-arrow', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' })
    ));
  }
  root.appendChild(foot);

  root.appendChild(el('a', { class: 'btn btn-ghost btn-full anim-rise', href: '/auth/logout',
    style: { marginTop: '14px', color: 'var(--red)', animationDelay: '0.15s' } }, 'Выйти'));
}

// ============ page: settings ============
async function renderAuthMethodsBlock(root, me) {
  const card = el('div', { class: 'card', style: { marginTop: '16px' } });
  card.appendChild(el('div', { class: 'card-eyebrow' }, 'Способы входа'));
  card.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--mute)', marginBottom: '14px' } },
    'Привяжите несколько способов чтобы иметь запасной вариант входа. Steam также включает CS2-статистику и инвентарь.'));

  // Placeholder while loading
  const list = el('div', { class: 'auth-methods-list' }, el('div', { style: { color: 'var(--mute)', fontSize: '12.5px' } }, 'Загрузка…'));
  card.appendChild(list);
  root.appendChild(card);

  const [methods, cfg] = await Promise.all([
    api.authMethods().catch(() => ({ ok: false, methods: [] })),
    api.authConfig().catch(() => ({ ok: false }))
  ]);
  list.innerHTML = '';
  const bound = new Set((methods.methods || []).map(m => m.provider));
  const canRemove = bound.size > 1; // need at least 1 method to keep account accessible

  // Render each bound method as a row
  for (const m of (methods.methods || [])) {
    const row = el('div', { class: 'auth-method-row' });
    const ico = el('div', { class: 'auth-method-ico ' + m.provider });
    if (m.provider === 'steam') {
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 0a12 12 0 0 0-11.93 11.06l6.43 2.66a3.4 3.4 0 0 1 1.92-.6h.17l2.85-4.13v-.06a4.55 4.55 0 1 1 4.55 4.55h-.1l-4.07 2.9v.13a3.41 3.41 0 0 1-6.79.5L.16 14.7A12 12 0 1 0 12 0Z"/></svg>';
    } else if (m.provider === 'telegram') {
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>';
    }
    const info = el('div', { class: 'auth-method-info' },
      el('div', { class: 'auth-method-name' },
        m.provider === 'steam' ? 'Steam' : 'Telegram',
        m.external_name ? el('span', { class: 'auth-method-sub' }, ' · ' + m.external_name) : null,
        m.external_username ? el('span', { class: 'auth-method-sub' }, ' @' + m.external_username) : null
      ),
      el('div', { class: 'auth-method-meta' },
        'Привязан ' + (m.created_at ? new Date(m.created_at).toLocaleDateString('ru-RU') : '—')
      )
    );
    const actions = el('div', { class: 'auth-method-actions' });
    if (canRemove) {
      actions.appendChild(el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: async () => {
          if (!confirm(`Отвязать ${m.provider === 'steam' ? 'Steam' : 'Telegram'} от аккаунта?`)) return;
          const r = await api.authUnbind(m.provider).catch(() => ({ ok: false }));
          if (r.ok) { toast.ok('Отвязано'); renderAuthMethodsBlock(root, me); card.remove(); }
          else if (r.error === 'last-method') toast.err('Это единственный способ входа — нельзя отвязать');
          else toast.err('Не удалось отвязать');
        }
      }, 'Отвязать'));
    } else {
      actions.appendChild(el('span', { class: 'auth-method-meta', style: { fontSize: '11px' } }, 'Единственный'));
    }
    row.appendChild(ico);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  }

  // "Add" buttons for unbound providers
  const adds = el('div', { class: 'auth-method-adds' });
  if (!bound.has('steam')) {
    adds.appendChild(el('a', { class: 'btn btn-primary', href: '/auth/steam',
      style: { marginRight: '8px' }
    },
      el('span', { html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:6px"><path d="M12 0a12 12 0 0 0-11.93 11.06l6.43 2.66a3.4 3.4 0 0 1 1.92-.6h.17l2.85-4.13v-.06a4.55 4.55 0 1 1 4.55 4.55h-.1l-4.07 2.9v.13a3.41 3.41 0 0 1-6.79.5L.16 14.7A12 12 0 1 0 12 0Z"/></svg>' }),
      'Привязать Steam'
    ));
  }
  if (!bound.has('telegram') && cfg.telegram && cfg.telegram_bot) {
    // Telegram widget for binding. Mounts a real Telegram button — clicking
    // sends the signed payload to /auth/telegram/callback, which detects the
    // existing session and binds instead of creating a new user.
    const tgMount = el('div', { id: 'tg-bind-mount', style: { display: 'inline-block', verticalAlign: 'middle', marginLeft: bound.has('steam') ? '0' : '8px' } });
    adds.appendChild(tgMount);
    // Inject the widget script
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', cfg.telegram_bot);
    s.setAttribute('data-size', 'medium');
    s.setAttribute('data-radius', '6');
    s.setAttribute('data-auth-url', `${location.origin}/auth/telegram/callback`);
    s.setAttribute('data-request-access', 'write');
    tgMount.appendChild(s);
  }
  if (adds.children.length) {
    list.appendChild(el('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--line)' } }, adds));
  }
}

async function pageSettings() {
  const me = await renderTopbar('settings');
  const root = $('#settings-root');
  if (!root) return;
  if (!me.logged_in) {
    toast.warn('Войдите через Steam, чтобы открыть настройки');
    setTimeout(() => location.replace('/'), 800);
    return;
  }

  root.innerHTML = '';
  const s = me.settings || { currency: 'RUB', language: 'ru', telegram_id: null };

  // ---- Account block: avatar + name + steamid ----
  const acc = el('div', { class: 'card' });
  acc.appendChild(el('div', { class: 'card-eyebrow' }, 'Аккаунт'));
  const accRow = el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } });
  const p = me.profile || {};
  if (p.avatarfull || p.avatar) {
    accRow.appendChild(el('img', {
      src: p.avatarfull || p.avatar, alt: '',
      style: { width: '56px', height: '56px', borderRadius: '10px', border: '1px solid var(--line-acc)' }
    }));
  } else {
    accRow.appendChild(el('div', {
      style: { width: '56px', height: '56px', borderRadius: '10px',
        background: 'var(--card-2)', border: '1px solid var(--line-acc)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px' }
    }, (p.personaname || '?').slice(0, 1).toUpperCase()));
  }
  accRow.appendChild(el('div', { style: { flex: 1, minWidth: 0 } },
    el('div', { style: { fontSize: '18px', fontWeight: 700, marginBottom: '4px' } }, p.personaname || me.steamid),
    el('div', { class: 'pc-sub', style: { marginTop: 0 } },
      `Steam ID: ${me.steamid}`,
      el('button', { type: 'button', title: 'Скопировать',
        onclick: () => { try { navigator.clipboard.writeText(me.steamid); toast.ok('SteamID скопирован'); } catch (_) {} }
      }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' })
      )
    )
  ));
  if (p.profileurl) {
    accRow.appendChild(el('a', { href: p.profileurl, target: '_blank', rel: 'noopener',
      class: 'btn btn-sm btn-outline' },
      'Профиль в Steam',
      el('span', { style: { marginLeft: '6px' }, html:
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' })
    ));
  }
  acc.appendChild(accRow);
  root.appendChild(acc);

  // ---- Auth methods block: Steam / Telegram bindings ----
  // Surface which login providers are bound to this account and let the user
  // attach more or remove existing ones. The user needs at least one to keep
  // their account accessible — the server enforces this on /api/auth/unbind.
  renderAuthMethodsBlock(root, me).catch(e => console.warn('[auth-methods]', e));

  // Show one-time banners for binding success/failures returned by callback redirects.
  const authParams = new URLSearchParams(location.search);
  const authMsg = {
    'steam-bound': { kind: 'ok', text: 'Steam-аккаунт привязан' },
    'tg-bound': { kind: 'ok', text: 'Telegram привязан' },
    'steam-already-bound': { kind: 'err', text: 'Этот Steam уже привязан к другому пользователю' },
    'tg-already-bound': { kind: 'err', text: 'Этот Telegram уже привязан к другому пользователю' }
  }[authParams.get('auth')];
  if (authMsg) {
    if (authMsg.kind === 'ok') toast.ok(authMsg.text); else toast.err(authMsg.text);
    // Clean the query string so refresh doesn't repeat the toast
    history.replaceState({}, '', location.pathname);
  }

  // ---- Preferences block ----
  const prefs = el('div', { class: 'card', style: { marginTop: '16px' } });
  prefs.appendChild(el('div', { class: 'card-eyebrow' }, 'Предпочтения'));

  // Currency
  prefs.appendChild(el('div', { class: 'field mb-2' },
    el('label', { class: 'field-label' }, 'Валюта цен'),
    el('select', { class: 'select', id: 'set-currency' },
      el('option', { value: 'RUB' }, 'RUB · Российский рубль (₽)'),
      el('option', { value: 'USD' }, 'USD · US Dollar ($)'),
      el('option', { value: 'EUR' }, 'EUR · Euro (€)')
    )
  ));
  // Language
  prefs.appendChild(el('div', { class: 'field mb-2' },
    el('label', { class: 'field-label' }, 'Язык интерфейса'),
    el('select', { class: 'select', id: 'set-language' },
      el('option', { value: 'ru' }, 'Русский'),
      el('option', { value: 'en' }, 'English (скоро)')
    )
  ));
  // Telegram ID
  prefs.appendChild(el('div', { class: 'field mb-2' },
    el('label', { class: 'field-label' }, 'Telegram ID для уведомлений'),
    el('input', { class: 'input', id: 'set-telegram', placeholder: '123456789',
      inputmode: 'numeric', autocomplete: 'off' }),
    el('div', { style: { fontSize: '11px', color: 'var(--mute)', marginTop: '4px' } },
      'Бота уведомлений ещё нет, но ID можно сохранить заранее.')
  ));
  // Faceit nickname (optional override — by default we look up by SteamID)
  prefs.appendChild(el('div', { class: 'field mb-2' },
    el('label', { class: 'field-label' }, 'Faceit-ник (опционально)'),
    el('input', { class: 'input', id: 'set-faceit', placeholder: 'ваш ник на Faceit',
      autocomplete: 'off', maxlength: '32' }),
    el('div', { style: { fontSize: '11px', color: 'var(--mute)', marginTop: '4px' } },
      'По умолчанию ищем Faceit-профиль по SteamID. Если ваш Faceit привязан к другому Steam, укажите ник вручную.')
  ));

  // Privacy: show activity (online + last seen) to other users
  prefs.appendChild(el('div', { class: 'field' },
    el('label', { class: 'field-label' }, 'Приватность'),
    el('label', { class: 'check-row', style: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' } },
      el('input', { type: 'checkbox', id: 'set-show-activity' }),
      el('span', null,
        el('div', { style: { fontWeight: 600 } }, 'Показывать мою активность'),
        el('div', { style: { fontSize: '11.5px', color: 'var(--mute)', marginTop: '2px' } },
          'Другие видят, в сети ли вы и когда были последний раз. Информация о текущей игре в Steam остаётся публичной независимо от этой настройки (это Steam-данные).'))
    )
  ));

  // Accessibility: large font toggle (local-only, per-device)
  const largeFontCheckbox = el('input', { type: 'checkbox', id: 'set-large-font' });
  try { largeFontCheckbox.checked = localStorage.getItem('sok:large-font') === '1'; } catch (_) {}
  largeFontCheckbox.addEventListener('change', () => {
    const on = largeFontCheckbox.checked;
    try { localStorage.setItem('sok:large-font', on ? '1' : '0'); } catch (_) {}
    document.body.classList.toggle('large-font', on);
    toast.ok(on ? 'Крупный шрифт включён' : 'Крупный шрифт выключен');
  });
  prefs.appendChild(el('div', { class: 'field' },
    el('label', { class: 'field-label' }, 'Доступность'),
    el('label', { class: 'check-row', style: { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' } },
      largeFontCheckbox,
      el('span', null,
        el('div', { style: { fontWeight: 600 } }, 'Крупный шрифт'),
        el('div', { style: { fontSize: '11.5px', color: 'var(--mute)', marginTop: '2px' } },
          'Увеличивает текст на сайте примерно на 20%. Помогает если зум недоступен. Настройка хранится локально, для этого устройства.'))
    )
  ));

  // Push notifications — per-device toggle. Server stores subscription per (user, endpoint).
  const pushStatus = el('div', { style: { fontSize: '11.5px', color: 'var(--mute)', marginTop: '6px', minHeight: '14px' } });
  const pushBtn = el('button', { class: 'btn', type: 'button', id: 'set-push-toggle',
    style: { minWidth: '180px', padding: '12px 20px', fontWeight: '700' } }, 'Загрузка…');
  const pushTestBtn = el('button', { class: 'btn btn-ghost', type: 'button', id: 'set-push-test',
    style: { marginLeft: '8px', display: 'none', padding: '12px 18px' } }, 'Прислать тест');

  async function refreshPushUi() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushBtn.disabled = true; pushBtn.textContent = 'Не поддерживается';
      pushStatus.textContent = 'Ваш браузер не умеет push-уведомления.';
      return;
    }
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isIos && !isStandalone) {
      pushBtn.disabled = true; pushBtn.textContent = 'Только в PWA';
      pushStatus.innerHTML = '⚠️ На iPhone push работает только если добавить сайт на главный экран. Откройте Safari → нажмите «Поделиться» → «На экран Домой».';
      return;
    }
    const enabled = await window.__push.isEnabled();
    pushBtn.disabled = false;
    pushBtn.textContent = enabled ? 'Выключить пуши' : 'Включить пуши';
    pushBtn.className = enabled ? 'btn btn-ghost' : 'btn btn-primary';
    pushTestBtn.style.display = enabled ? '' : 'none';
    if (Notification.permission === 'denied') {
      pushStatus.textContent = '⚠️ Уведомления заблокированы в браузере. Разрешите их в настройках сайта.';
    } else if (enabled) {
      pushStatus.textContent = 'Push-уведомления включены на этом устройстве. Вы будете получать сообщения и комменты даже при закрытом сайте.';
    } else {
      pushStatus.textContent = 'Получайте сообщения и комменты даже когда сайт закрыт. Можно выключить в любой момент.';
    }
  }

  pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    const wasEnabled = await window.__push.isEnabled();
    if (wasEnabled) {
      await window.__push.disable();
      toast.ok('Push-уведомления выключены');
    } else {
      const r = await window.__push.enable();
      if (r.ok) {
        toast.ok('Push-уведомления включены!');
      } else if (r.status === 'denied') {
        toast.err('Уведомления заблокированы в браузере');
      } else if (r.status === 'ios-not-standalone') {
        toast.err('На iPhone — сначала добавьте сайт на главный экран');
      } else if (r.status === 'unsupported') {
        toast.err('Браузер не поддерживает пуши');
      } else {
        toast.err('Не удалось подключить (' + (r.error || r.status) + ')');
      }
    }
    refreshPushUi();
  });

  pushTestBtn.addEventListener('click', async () => {
    pushTestBtn.disabled = true;
    try {
      const r = await fetch('/api/push/test', { method: 'POST' }).then(r => r.json());
      if (r.ok && r.delivered > 0) toast.ok('Тест отправлен — проверьте уведомления');
      else if (r.ok) toast.warn('Сервер отправил, но ни одна подписка не доставлена. Возможно браузер только что отключил пуши.');
      else toast.err('Не удалось отправить: ' + (r.error || ''));
    } catch (_) {
      toast.err('Сетевая ошибка');
    } finally {
      pushTestBtn.disabled = false;
    }
  });

  prefs.appendChild(el('div', { class: 'field' },
    el('label', { class: 'field-label' }, 'Push-уведомления'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' } }, pushBtn, pushTestBtn),
    pushStatus
  ));
  refreshPushUi();

  // Profile cover — banner image shown on the player's profile page
  // Initialize from settings; saved with the rest on Save click.
  const coverField = imageUploadField('Обложка профиля', s.cover_url || '');
  window.__coverField = coverField; // accessible from Save handler
  prefs.appendChild(el('div', { class: 'field' },
    el('label', { class: 'field-label' }, 'Внешний вид профиля'),
    coverField.node,
    el('div', { style: { fontSize: '11.5px', color: 'var(--mute)', marginTop: '4px' } },
      'Картинка-шапка показывается сверху вашего профиля для других игроков. Рекомендуемый размер 1500×500 пикселей.')
  ));

  prefs.appendChild(el('div', { class: 'flex gap-1 mt-2' },
    el('button', { class: 'btn btn-primary', id: 'set-save', type: 'button' }, 'Сохранить'),
    el('button', { class: 'btn btn-ghost', id: 'set-revert', type: 'button',
      style: { marginLeft: 'auto' } }, 'Отменить изменения')
  ));
  root.appendChild(prefs);

  // ---- Match tracking block (honest empty state) ----
  root.appendChild(el('div', { class: 'card', style: { marginTop: '16px' } },
    el('div', { class: 'card-eyebrow' }, 'Трекинг матчей'),
    el('div', { class: 'empty-state' },
      el('div', { class: 'icon' }, '🎮'),
      el('div', { class: 'title' }, 'История матчей — в разработке'),
      el('div', { class: 'desc' },
        'Для детальных разборов матчей нужны Game Authentication Code и парсер демок. ',
        'В MVP не подключено. Дашборд показывает суммарные данные из Steam UserStats.')
    )
  ));

  // ---- Danger zone ----
  const danger = el('div', { class: 'card', style: { marginTop: '16px', borderColor: 'rgba(239,68,68,0.2)' } });
  danger.appendChild(el('div', { class: 'card-eyebrow', style: { color: 'var(--red)' } }, 'Опасная зона'));
  danger.appendChild(el('div', { class: 'flex gap-1', style: { alignItems: 'center', flexWrap: 'wrap' } },
    el('div', { style: { flex: 1, minWidth: '240px' } },
      el('div', { style: { fontWeight: 600, marginBottom: '2px' } }, 'Выйти из аккаунта'),
      el('div', { style: { fontSize: '12px', color: 'var(--dim)' } },
        'Сессия будет удалена. Локальные настройки в БД сохранятся, цены остаются в общем кэше.')
    ),
    el('form', { method: 'POST', action: '/auth/logout', style: { margin: 0 } },
      el('button', { type: 'submit', class: 'btn btn-danger' }, 'Выйти')
    )
  ));
  root.appendChild(danger);

  // Initial values
  const applyValues = () => {
    $('#set-currency').value = s.currency || 'RUB';
    $('#set-language').value = s.language || 'ru';
    $('#set-telegram').value = s.telegram_id || '';
    $('#set-faceit').value = s.faceit_nickname || '';
    $('#set-show-activity').checked = s.show_activity == null ? true : !!s.show_activity;
  };
  applyValues();

  $('#set-revert').addEventListener('click', applyValues);

  $('#set-save').addEventListener('click', async () => {
    const btn = $('#set-save');
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Сохраняем…';
    try {
      const r = await api.settings.save({
        currency: $('#set-currency').value,
        language: $('#set-language').value,
        telegram_id: $('#set-telegram').value.trim() || null,
        faceit_nickname: $('#set-faceit').value.trim() || null,
        show_activity: $('#set-show-activity').checked,
        cover_url: window.__coverField?.getUrl() || null
      });
      if (r.ok) {
        Object.assign(s, r.settings);
        toast.ok('Настройки сохранены');
      } else {
        toast.err('Не удалось сохранить');
      }
    } catch (e) {
      toast.err('Ошибка: ' + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = origText;
    }
  });
}

// ============ router (based on body[data-page]) ============
document.addEventListener('DOMContentLoaded', () => {
  // Restore accessibility preferences early (before paint)
  try { if (localStorage.getItem('sok:large-font') === '1') document.body.classList.add('large-font'); } catch (_) {}
  initCookieBanner();
  track('page_view');
  const page = document.body.dataset.page;
  const router = { index: pageIndex, dashboard: pageDashboard, feed: pageFeed, messages: pageMessages, inventory: pageInventory, lookup: pageLookup, settings: pageSettings, admin: pageAdmin, me: pageMe, friends: pageFriends, communities: pageCommunities, notifications: pageNotifications };
  const fn = router[page];
  if (fn) fn().catch(e => { console.error(e); toast.err('Ошибка: ' + (e.message || e)); });
});

// Cookie consent banner — shown once until accepted (stored in localStorage)
function initCookieBanner() {
  try { if (localStorage.getItem('sok:cookieConsent') === '1') return; } catch (_) {}
  const banner = el('div', { class: 'cookie-banner' },
    el('div', { class: 'cookie-banner-text' },
      'Мы используем только необходимые файлы cookie для работы авторизации. Продолжая пользоваться сайтом, вы соглашаетесь с этим и принимаете нашу ',
      el('a', { href: '/privacy' }, 'Политику конфиденциальности'), '.'),
    el('div', { class: 'cookie-banner-actions' },
      el('button', { class: 'btn btn-sm', type: 'button',
        onclick: () => { try { localStorage.setItem('sok:cookieConsent', '1'); } catch (_) {} banner.remove(); }
      }, 'Принять'))
  );
  document.body.appendChild(banner);
}

// Expose for debugging
window.SOK = { api, toast, $, $$, el, steamLogin };
})();


// public/app.js
// SOKOLENOK / LUDIK shared frontend logic.
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
  health() { return this.request('/api/health'); },
  resolve(target) { return this.request(`/api/resolve?target=${encodeURIComponent(target)}`); },
  profile(steamid) { return this.request(`/api/profile/${steamid}`); },
  inventory(steamid, opts = {}) {
    const q = new URLSearchParams();
    if (opts.currency) q.set('currency', opts.currency);
    if (opts.noPrices) q.set('no_prices', '1');
    if (opts.cachedOk) q.set('cached_ok', '1');
    if (opts.force) q.set('force', '1');
    return this.request(`/api/inventory/${steamid}${q.toString() ? '?' + q : ''}`);
  },
  inventoryHistory(steamid) { return this.request(`/api/inventory/history?steamid=${steamid}`); },
  news(count = 10) {
    // News can be slow if Steam is having a bad day — race against a 10s timeout
    return Promise.race([
      this.request(`/api/news?count=${count}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('news-timeout')), 10000))
    ]);
  },
  stats(steamid) { return this.request(`/api/stats/${steamid}`); },
  bans(steamid)    { return this.request(`/api/playerbans/${steamid}`); },
  leetify(steamid) { return this.request(`/api/leetify/${steamid}`); },
  reputation: {
    get(steamid)  { return api.request(`/api/reputation/${steamid}`); },
    vote(steamid, categories, comment) {
      return api.request(`/api/reputation/${steamid}`, {
        method: 'POST', body: JSON.stringify({ categories, comment: comment || null })
      });
    },
    remove(steamid) {
      return api.request(`/api/reputation/${steamid}`, { method: 'DELETE' });
    }
  },
  feed(scope = 'all') { return this.request(`/api/feed?scope=${encodeURIComponent(scope)}`); },
  publics() { return this.request('/api/publics'); },
  createPublic(data) { return this.request('/api/publics', { method: 'POST', body: JSON.stringify(data) }); },
  publicDetail(id) { return this.request(`/api/publics/${encodeURIComponent(id)}`); },
  updatePublic(id, data) { return this.request(`/api/publics/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }); },
  deletePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  createPost(data) { return this.request('/api/posts', { method: 'POST', body: JSON.stringify(data) }); },
  deletePost(id) { return this.request(`/api/posts/${id}`, { method: 'DELETE' }); },
  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    return res.json().catch(() => ({ ok: false }));
  },
  subscribePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}/subscribe`, { method: 'POST' }); },
  unsubscribePublic(id) { return this.request(`/api/publics/${encodeURIComponent(id)}/subscribe`, { method: 'DELETE' }); },
  friends() { return this.request('/api/friends'); },
  friendStatus(id) { return this.request(`/api/friends/${id}`); },
  friendRequest(id) { return this.request(`/api/friends/${id}/request`, { method: 'POST' }); },
  friendAccept(id) { return this.request(`/api/friends/${id}/accept`, { method: 'POST' }); },
  friendRemove(id) { return this.request(`/api/friends/${id}`, { method: 'DELETE' }); },
  blocks() { return this.request('/api/blocks'); },
  block(id) { return this.request(`/api/blocks/${id}`, { method: 'POST' }); },
  unblock(id) { return this.request(`/api/blocks/${id}`, { method: 'DELETE' }); },
  conversations() { return this.request('/api/conversations'); },
  messages(id) { return this.request(`/api/messages/${id}`); },
  sendMessage(id, text) { return this.request(`/api/messages/${id}`, { method: 'POST', body: JSON.stringify({ text }) }); },
  report(target_type, target_id, reason) {
    return this.request('/api/report', { method: 'POST', body: JSON.stringify({ target_type, target_id, reason }) });
  },
  admin: {
    stats() { return api.request('/api/admin/stats'); },
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
    removeModerator(id) { return api.request(`/api/admin/moderator/${id}/remove`, { method: 'POST' }); }
  },
  publicEditors(pid) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors`); },
  addPublicEditor(pid, id) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors/${id}`, { method: 'POST' }); },
  removePublicEditor(pid, id) { return this.request(`/api/publics/${encodeURIComponent(pid)}/editors/${id}`, { method: 'DELETE' }); },
  faceit(steamid, opts = {}) {
    const q = new URLSearchParams();
    if (opts.nickname) q.set('nickname', opts.nickname);
    if (opts.matches) q.set('matches', String(opts.matches));
    const qs = q.toString();
    return this.request(`/api/faceit/${steamid}${qs ? '?' + qs : ''}`);
  },
  prices(names, currency = 'RUB') {
    const q = new URLSearchParams({ names: names.join(','), currency });
    return this.request(`/api/prices?${q}`);
  },
  priceHistory(name, currency = 'RUB', days = 30) {
    const q = new URLSearchParams({ name, currency, days });
    return this.request(`/api/price-history?${q}`);
  },
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

// ============ sidebar + main toolbar ============
// Returns the `me` object so callers can use logged_in state immediately.
async function renderTopbar(active = '') {
  const me = await api.me().catch(() => ({ logged_in: false }));
  window.__me = me;
  if (active !== 'messages') document.body.classList.remove('msgr-thread-open');
  renderSidebar(active, me);
  renderMainToolbar(me);
  ensureMobileNav();
  ensureSupportButton(me);
  // First-login consent gate (152-ФЗ explicit consent)
  if (me.logged_in && me.consented === false) showConsentGate();
  return me;
}

// Floating "Support" button (bottom-right) for logged-in users.
function ensureSupportButton(me) {
  const existing = document.getElementById('support-fab');
  if (!me || !me.logged_in) { if (existing) existing.remove(); return; }
  if (existing) return;
  const fab = el('button', {
    id: 'support-fab', class: 'support-fab', type: 'button', title: 'Связь с поддержкой',
    onclick: openSupportModal,
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'
  });
  document.body.appendChild(fab);
}

// Anti-scam explainer before redirecting to Steam OpenID.
function steamLogin(ev) {
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
  }, 'Отправить');
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
    const isActive = active === item.key || (item.key === 'me' && active === 'settings');
    const link = el('a', { class: 'bn-item' + (isActive ? ' active' : ''), href: item.href },
      el('span', { class: 'bn-icon', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${navIconPath(item.icon)}</svg>` }),
      el('span', { class: 'bn-label' }, item.label)
    );
    if (item.badge) {
      const b = el('span', { class: 'bn-badge', id: 'bn-unread', style: { display: 'none' } }, '');
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
    const r = await api.conversations();
    const n = r?.unread_total || 0;
    for (const id of ['nav-unread-badge', 'bn-unread']) {
      const badge = document.getElementById(id);
      if (!badge) continue;
      if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = ''; }
      else { badge.style.display = 'none'; }
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
    { href: '/feed',      label: 'Лента',      key: 'feed',      icon: 'feed' },
    { href: '/messages',  label: 'Сообщения',  key: 'messages',  icon: 'mail', badge: 'unread' },
    { href: '/inventory', label: 'Инвентарь', key: 'inventory', icon: 'inventory' }
  ];
  const authedBottom = [
    { href: '/settings',  label: 'Настройки', key: 'settings',  icon: 'settings' }
  ];

  bar.innerHTML = '';

  // Brand
  bar.appendChild(el('div', { class: 'brand' },
    el('a', { href: me.logged_in ? '/dashboard' : '/' },
      el('img', { src: '/assets/logo-full-dark.png', alt: 'SOKOLENOK', class: 'brand-logo' })
    ),
    el('span', { class: 'brand-tag' }, 'by LUDIK')
  ));

  // Main nav (top)
  const nav = el('nav', { class: 'nav' });
  const topItems = me.logged_in ? authedTop : baseItems;
  for (const item of topItems) {
    const link = el('a', {
      class: `nav-link${active === item.key ? ' active' : ''}`,
      href: item.href
    }, navIcon(item.icon), el('span', { class: 'nav-label' }, item.label));
    if (item.badge === 'unread') {
      // placeholder badge, filled async by refreshUnreadBadge()
      link.appendChild(el('span', { class: 'nav-badge', id: 'nav-unread-badge', style: { display: 'none' } }, '0'));
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
    '© 2026 LUDIK · SOKOLENOK.PRO'));

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
        const r = await api.resolve(input);
        if (r.ok) location.assign(`/lookup?steamid=${r.steamid}`);
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
  if (params.get('auth') === 'failed' || params.get('auth') === 'invalid') {
    const banner = el('div', { class: 'alert alert-error' },
      el('div', null,
        el('strong', null, 'Вход не удался'),
        el('div', { class: 'text-sm mt-1' }, 'Steam не подтвердил OpenID. Попробуй ещё раз.')
      ));
    const target = $('.hero');
    if (target) target.parentNode.insertBefore(banner, target);
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

function emptyCard(title, message, icon = '📊') {
  return el('div', { class: 'card' },
    el('div', { class: 'card-h' }, el('h2', null, title)),
    el('div', { class: 'empty-state' },
      el('div', { class: 'icon' }, icon),
      el('div', { class: 'title' }, 'Пока нет данных'),
      el('div', { class: 'desc' }, message)
    )
  );
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
  // Clear any leftover data-attr from old mode logic (no-op if absent)
  delete document.body.dataset.dashMode;

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
      href: `/lookup?steamid=${it.steamid}`
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
      location.assign(`/lookup?steamid=${r.steamid}`);
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
  const movers = computeMovers(inv, state.history);
  const upCard = el('div', { class: 'card' });
  upCard.appendChild(el('div', { class: 'card-eyebrow', style: { color: 'var(--g)' } }, 'Лидеры роста'));
  if (movers.up.length === 0) {
    upCard.appendChild(el('div', { class: 'empty-state' },
      el('div', { class: 'desc' }, 'Сравнение появится после повторного визита')));
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
      el('div', { class: 'desc' }, 'Сравнение появится после повторного визита')));
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

function computeMovers(inv, history) {
  const out = { up: [], down: [] };
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

  if (!steamid || !/^\d{17}$/.test(steamid)) {
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
  paintLookupFaceit(faceitR);
  paintLookupLeetify(leetifyR);
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

  // Fetch current relationship status
  let status = 'none';
  try { const r = await api.friendStatus(steamid); status = r?.status || 'none'; } catch (_) {}

  const card = el('div', { class: 'card lk-social-card' });
  const actions = el('div', { class: 'lk-social-actions' });

  const rerender = () => paintLookupSocial(steamid, profR);

  if (status === 'friends') {
    actions.appendChild(el('a', { class: 'btn lk-social-primary', href: `/messages?to=${steamid}` }, 'Написать'));
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

  card.appendChild(actions);
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

  // Update page title
  if (p.personaname) {
    const t = $('#lk-title');
    if (t) t.textContent = p.personaname;
  }

  const vis = Number(p.communityvisibilitystate || 0);
  const visText = vis === 3 ? 'Публичный' : vis === 2 ? 'Только друзья' : 'Закрытый';
  const visKind = vis === 3 ? 'green' : '';
  const sinceYear = p.timecreated ? new Date(p.timecreated * 1000).getFullYear() : null;
  const h = statsR?.summary?.headline || {};

  const card = el('div', { class: 'card prof-card' });
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
  info.appendChild(nameRow);
  info.appendChild(el('div', { class: 'pc-sub' },
    `Steam ID: ${p.steamid || '—'}`,
    el('button', { type: 'button', title: 'Скопировать',
      onclick: () => { try { navigator.clipboard.writeText(p.steamid || ''); toast.ok('SteamID скопирован'); } catch (_) {} }
    }, el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }))
  ));
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
  if (sid) {
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
    list.appendChild(emptyCard('Пока нет постов', p.is_owner ? 'Опубликуйте первый пост.' : 'Здесь пока пусто.', '📝'));
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
      (p.is_owner || me.is_admin) ? el('button', { class: 'feed-del', type: 'button', title: 'Удалить',
        onclick: async () => { if (confirm('Удалить пост?')) { await api.deletePost(post.id); toast.ok('Удалён'); renderPublicPage(publicId, me); } },
        html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }) : null
    ));
    if (post.title) card.appendChild(el('div', { class: 'feed-item-title' }, post.title));
    if (post.body) card.appendChild(el('div', { class: 'feed-item-body', style: { whiteSpace: 'pre-wrap' } }, post.body));
    if (post.image) {
      const img = el('img', { class: 'feed-item-img', src: post.image, alt: '', loading: 'lazy' });
      img.onerror = function() { this.remove(); };
      card.appendChild(img);
    }
    if (post.link) card.appendChild(el('a', { class: 'feed-item-link', href: post.link, target: '_blank', rel: 'noopener' }, 'Перейти по ссылке →'));
    list.appendChild(card);
  }
}

function paintFeedList(r) {
  const root = $('#feed-list');
  if (!root) return;
  root.innerHTML = '';

  const items = r?.items || [];
  if (!items.length) {
    root.appendChild(emptyCard('Лента пуста',
      r?.scope === 'subs'
        ? 'Вы пока ни на кого не подписаны. Подпишитесь на паблики справа, чтобы видеть их посты.'
        : 'Пока нет записей. Официальные новости появятся здесь.',
      '📰'));
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
    if (it.body) card.appendChild(el('div', { class: 'feed-item-body' }, stripFeedHtml(it.body)));
    if (it.image) {
      const img = el('img', { class: 'feed-item-img', src: it.image, alt: '', loading: 'lazy' });
      img.onerror = function() { this.remove(); };
      card.appendChild(img);
    }
    if (it.link) {
      card.appendChild(el('a', { class: 'feed-item-link', href: it.link, target: '_blank', rel: 'noopener' },
        'Читать полностью ',
        el('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>' })
      ));
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
function openEditorsModal(pub) {
  const listBox = el('div', { class: 'editors-list' });
  const input = el('input', { class: 'modal-input', placeholder: 'SteamID нового редактора (76561...)' });
  const reload = async () => {
    listBox.innerHTML = '<div class="loading-inline" style="padding:10px"><div class="spinner sm"></div>Загрузка…</div>';
    const r = await api.publicEditors(pub.id).catch(() => ({ ok: false, editors: [] }));
    listBox.innerHTML = '';
    if (!r.editors?.length) {
      listBox.appendChild(el('div', { class: 'modal-hint' }, 'Редакторов пока нет. Они смогут публиковать посты в этом паблике.'));
    } else {
      for (const e of r.editors) {
        listBox.appendChild(el('div', { class: 'editor-row' },
          el('a', { class: 'editor-name', href: `/lookup?steamid=${e.steam_id}` }, e.name || e.steam_id),
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
        const id = input.value.trim();
        if (!/^\d{17}$/.test(id)) { toast.warn('Неверный SteamID'); return; }
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
  }, 'Сохранить');
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
  }, 'Создать');
}

// Modal: create a post in a public
function openCreatePostModal(pub) {
  const titleInput = el('input', { class: 'modal-input', placeholder: 'Заголовок (необязательно)', maxlength: '200' });
  const bodyInput = el('textarea', { class: 'modal-input', rows: '5', placeholder: 'Текст поста…', maxlength: '5000' });
  const linkInput = el('input', { class: 'modal-input', placeholder: 'Ссылка (необязательно)', maxlength: '500' });
  const img = imageUploadField('Картинка', '');
  openModal(`Новый пост · ${pub.name}`, [
    titleInput, bodyInput,
    el('label', { class: 'modal-label' }, 'Ссылка'), linkInput,
    img.node
  ], async () => {
    const body = bodyInput.value.trim();
    const title = titleInput.value.trim();
    if (!body && !title) { toast.warn('Введите текст или заголовок'); return false; }
    const res = await api.createPost({ public_id: pub.id, title, body, link: linkInput.value.trim(), image: img.getUrl() }).catch(() => ({ ok: false }));
    if (res.ok) { toast.ok('Опубликовано'); location.reload(); return true; }
    toast.err('Не удалось опубликовать');
    return false;
  }, 'Опубликовать');
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

// Generic modal helper
function openModal(title, contentNodes, onConfirm, confirmLabel = 'OK') {
  const existing = $('#modal-host'); if (existing) existing.remove();
  const host = el('div', { id: 'modal-host', class: 'modal-host' });
  const close = () => host.remove();
  const confirmBtn = el('button', { class: 'btn', type: 'button' }, confirmLabel);
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const keep = await onConfirm();
    if (keep) close();
    else confirmBtn.disabled = false;
  });
  const dialog = el('div', { class: 'modal-dialog' },
    el('div', { class: 'modal-head' },
      el('div', { class: 'modal-title' }, title),
      el('button', { class: 'modal-x', type: 'button', onclick: close, html: '&times;' })
    ),
    el('div', { class: 'modal-body' }, ...contentNodes),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Отмена'),
      confirmBtn
    )
  );
  host.appendChild(dialog);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  document.body.appendChild(host);
}

// Strip HTML/bbcode-ish noise from Steam news bodies for a clean feed preview
function stripFeedHtml(s) {
  let t = String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\/?[^\]]+\]/g, ' ')   // [b]...[/b], [url=...] bbcode
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 320) t = t.slice(0, 320).replace(/\s+\S*$/, '') + '…';
  return t;
}

// Relative date in Russian
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

// ============ page: messages ============
async function pageMessages() {
  const me = await renderTopbar('messages');
  if (!me.logged_in) {
    toast.warn('Войдите через Steam, чтобы открыть сообщения');
    setTimeout(() => location.replace('/'), 800);
    return;
  }

  const state = { tab: 'chats', activeOther: null, pollTimer: null };

  // Tabs
  const tabs = $('#msgr-tabs');
  if (tabs) {
    for (const btn of tabs.querySelectorAll('.msgr-tab')) {
      btn.addEventListener('click', () => {
        for (const b of tabs.querySelectorAll('.msgr-tab')) b.classList.remove('active');
        btn.classList.add('active');
        state.tab = btn.dataset.tab;
        renderLeft();
      });
    }
  }

  async function renderLeft() {
    const list = $('#msgr-list');
    if (!list) return;
    list.innerHTML = '<div class="loading-inline" style="padding:20px"><div class="spinner sm"></div>Загрузка…</div>';
    if (state.tab === 'chats') {
      const r = await api.conversations().catch(() => ({ ok: false, conversations: [] }));
      renderChatList(r.conversations || []);
    } else {
      const r = await api.friends().catch(() => ({ ok: false, friends: [], incoming: [], outgoing: [] }));
      renderFriendList(r);
    }
  }

  function renderChatList(convos) {
    const list = $('#msgr-list');
    list.innerHTML = '';
    if (!convos.length) {
      list.appendChild(el('div', { class: 'msgr-list-empty' },
        'Пока нет диалогов. Откройте профиль друга и нажмите «Написать».'));
      return;
    }
    for (const c of convos) {
      list.appendChild(el('div', {
        class: 'msgr-convo' + (state.activeOther === c.steam_id ? ' active' : ''),
        onclick: () => openThread(c.steam_id)
      },
        avatarEl(c.avatar, c.name, 'msgr-avatar'),
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
        list.appendChild(el('div', { class: 'msgr-list-empty' }, 'Пусто.'));
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
          el('a', { class: 'msgr-friend-name', href: `/lookup?steamid=${f.steam_id}` }, f.name),
          actions
        ));
      }
    }
  }

  async function openThread(other) {
    state.activeOther = other;
    state.lastMsgId = 0;
    state.lastDate = null;
    document.body.classList.add('msgr-thread-open'); // mobile: show thread, hide list
    renderLeft(); // refresh active highlight
    const right = $('#msgr-right');
    right.innerHTML = '<div class="loading-inline" style="padding:40px;justify-content:center"><div class="spinner"></div></div>';
    const r = await api.messages(other).catch(() => ({ ok: false }));
    if (!r.ok) { right.innerHTML = '<div class="msgr-empty"><div class="msgr-empty-title">Не удалось загрузить</div></div>'; return; }
    paintThread(r);
    refreshUnreadBadge(); // opening marks read
  }

  // Append only messages we haven't drawn yet (by id), inserting date separators as needed.
  function renderMessages(messages) {
    const scroll = $('#msgr-thread-scroll');
    if (!scroll) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    let added = false;
    for (const m of messages) {
      if (m.id != null && m.id <= state.lastMsgId) continue; // already drawn
      const d = m.created_at ? new Date(m.created_at).toDateString() : null;
      if (d && d !== state.lastDate) {
        scroll.appendChild(el('div', { class: 'msgr-date-sep' },
          el('span', null, msgDateLabel(m.created_at))));
        state.lastDate = d;
      }
      scroll.appendChild(el('div', { class: 'msgr-bubble-row ' + (m.from_me ? 'me' : 'them'),
        'data-mid': m.id != null ? String(m.id) : '' },
        el('div', { class: 'msgr-bubble' },
          el('div', { class: 'msgr-bubble-text' }, m.text),
          el('div', { class: 'msgr-bubble-time' }, m.created_at ? msgTime(m.created_at) : '')
        )
      ));
      if (m.id != null && m.id > state.lastMsgId) state.lastMsgId = m.id;
      added = true;
    }
    if (added && nearBottom) {
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
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
        onclick: () => { document.body.classList.remove('msgr-thread-open'); state.activeOther = null; renderLeft(); },
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' }),
      avatarEl(o.avatar, o.name, 'msgr-avatar'),
      el('div', { class: 'msgr-thread-h-info' },
        el('a', { class: 'msgr-thread-name', href: `/lookup?steamid=${o.steam_id}` }, o.name)
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
    renderMessages(r.messages || []);

    // Composer (only if still friends)
    if (r.friend) {
      const input = el('textarea', { class: 'msgr-input', rows: '1', placeholder: 'Сообщение…', maxlength: '2000' });
      const send = async () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = ''; input.style.height = 'auto';
        const res = await api.sendMessage(o.steam_id, text).catch(() => ({ ok: false }));
        if (res.ok && res.message) {
          renderMessages([res.message]); // instant, incremental
          // bump convo list preview
          renderLeft();
        } else {
          toast.err(res.error === 'not-friends' ? 'Вы больше не друзья' : res.error === 'blocked' ? 'Недоступно' : 'Не отправлено');
          input.value = text;
        }
      };
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      right.appendChild(el('div', { class: 'msgr-composer' },
        input,
        el('button', { class: 'msgr-send', type: 'button', onclick: send,
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' })
      ));
      requestAnimationFrame(() => input.focus());
    } else {
      right.appendChild(el('div', { class: 'msgr-composer-locked' },
        'Вы не друзья — переписка недоступна. Добавьте игрока в друзья на странице профиля.'));
    }

    // scroll to bottom on initial paint
    requestAnimationFrame(() => { const s = $('#msgr-thread-scroll'); if (s) s.scrollTop = s.scrollHeight; });
  }

  // Initial load; if URL has ?to=steamid, open that thread
  await renderLeft();
  const toId = new URLSearchParams(location.search).get('to');
  if (toId && /^\d{17}$/.test(toId)) openThread(toId);

  // Light polling: fetch the open thread and append ONLY new messages (no full repaint).
  // Poll a bit faster (6s) so incoming messages feel near-real-time.
  state.pollTimer = setInterval(() => {
    if (state.activeOther) {
      api.messages(state.activeOther).then(r => {
        if (!r.ok) return;
        // Only append new bubbles; don't rebuild the thread (keeps scroll + input intact)
        if ($('#msgr-thread-scroll')) renderMessages(r.messages || []);
      }).catch(() => {});
    }
    refreshUnreadBadge();
  }, 6000);
}

function avatarEl(src, name, cls) {
  const wrap = el('div', { class: cls || 'msgr-avatar' });
  if (src) {
    const img = el('img', { src, alt: '', loading: 'lazy' });
    img.onerror = function() { this.remove(); wrap.textContent = (name || '?').slice(0, 1).toUpperCase(); };
    wrap.appendChild(img);
  } else {
    wrap.textContent = (name || '?').slice(0, 1).toUpperCase();
  }
  return wrap;
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
    if (tab === 'moderators') return paintAdminModerators(panel);
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
          el('div', { class: 'admin-row-title' }, el('a', { href: `/lookup?steamid=${m.steam_id}` }, m.name || m.steam_id)),
          el('div', { class: 'admin-row-sub' }, 'Назначен ', relDate(m.created_at))),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { if (confirm('Снять модератора?')) { await api.admin.removeModerator(m.steam_id); toast.ok('Снят'); paintAdminModerators(panel); } } }, 'Снять'))
      ));
    }
  }
  const input = el('input', { class: 'admin-input', placeholder: 'SteamID нового модератора (76561...)' });
  card.appendChild(el('div', { class: 'admin-manual' },
    input,
    el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      const id = input.value.trim();
      if (!/^\d{17}$/.test(id)) { toast.warn('Неверный SteamID'); return; }
      const res = await api.admin.addModerator(id);
      if (res.ok) { toast.ok('Модератор назначен'); paintAdminModerators(panel); }
      else toast.err('Ошибка');
    } }, 'Назначить')
  ));
  panel.appendChild(card);
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
          'От: ', el('a', { href: `/lookup?steamid=${rep.reporter_steam_id}` }, rep.reporter_name || rep.reporter_steam_id),
          rep.reason ? ` · «${rep.reason}»` : '',
          ' · ', relDate(rep.created_at))
      ),
      el('div', { class: 'admin-row-actions' },
        isSupport ? el('a', { class: 'btn btn-sm', href: `/messages?to=${rep.reporter_steam_id}` }, 'Ответить') : null,
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
          el('div', { class: 'admin-row-title' }, el('a', { href: `/lookup?steamid=${b.steam_id}` }, b.name || b.steam_id)),
          el('div', { class: 'admin-row-sub' }, (b.reason || 'без причины'), ' · ', relDate(b.created_at))
        ),
        el('div', { class: 'admin-row-actions' },
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => { await api.admin.unban(b.steam_id); toast.ok('Разбанен'); paintAdminBans(panel); } }, 'Разбанить'))
      ));
    }
  }
  // Manual ban by SteamID
  const banInput = el('input', { class: 'admin-input', placeholder: 'SteamID для бана (76561...)' });
  card.appendChild(el('div', { class: 'admin-manual' },
    banInput,
    el('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      const id = banInput.value.trim();
      if (!/^\d{17}$/.test(id)) { toast.warn('Неверный SteamID'); return; }
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
    el('div', { class: 'admin-row-title' }, 'Проверить игрока'),
    el('div', { class: 'admin-row-sub' }, 'Открыть полную карточку игрока по SteamID.')
  ));
  const input = el('input', { class: 'admin-input', placeholder: 'SteamID (76561...)' });
  card.appendChild(el('div', { class: 'admin-manual' },
    input,
    el('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
      const id = input.value.trim();
      if (!/^\d{17}$/.test(id)) { toast.warn('Неверный SteamID'); return; }
      location.href = `/lookup?steamid=${id}`;
    } }, 'Открыть')
  ));
  panel.appendChild(card);
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
    el('a', { class: 'btn btn-full', href: `/lookup?steamid=${me.steamid}`, style: { marginTop: '14px' } }, 'Открыть мой профиль')
  );
  root.appendChild(profCard);

  // Menu items
  const items = [
    { href: '/lookup', label: 'Проверить игрока', icon: 'users', desc: 'Анализ любого по SteamID' },
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
        faceit_nickname: $('#set-faceit').value.trim() || null
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
  initCookieBanner();
  const page = document.body.dataset.page;
  const router = { index: pageIndex, dashboard: pageDashboard, feed: pageFeed, messages: pageMessages, inventory: pageInventory, lookup: pageLookup, settings: pageSettings, admin: pageAdmin, me: pageMe };
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

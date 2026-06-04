// lib/og-card.js — generate Open Graph preview cards (1200x630 PNG).
//
// Public API:
//   renderProfileCard({ name, steamId, avatar, vacBanned, kd, hsPercent, hoursCs2 }) → Buffer
//   renderInventoryCard({ name, avatar, totalValue, totalValueText, itemCount, currency }) → Buffer
//   renderPostCard({ publicName, title, body, image }) → Buffer
//
// All inputs are optional — missing data is rendered with placeholders.
// Avatars are fetched from URL once and passed in as Buffer.

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');

const W = 1200, H = 630;

// Colors borrowed from styles.css :root vars
const COLOR_BG = '#0a0d0c';
const COLOR_BG_2 = '#11171a';
const COLOR_GREEN = '#4ade80';
const COLOR_GREEN_DIM = 'rgba(74, 222, 128, 0.15)';
const COLOR_TEXT = '#ffffff';
const COLOR_DIM = '#a8b2c1';
const COLOR_MUTE = '#5a6470';
const COLOR_RED = '#ef4444';

// Try to register Inter from public/assets if it's there. Fallback to system sans-serif.
let _fontsLoaded = false;
function ensureFonts() {
  if (_fontsLoaded) return;
  _fontsLoaded = true;
  // No bundled fonts — we rely on canvas default (DejaVu Sans on Linux),
  // which handles Cyrillic. Setting font weight/size in fillText handles the rest.
}

// Soft background with a green-tinted radial highlight in the upper-left.
function paintBackground(ctx) {
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createRadialGradient(150, 100, 50, 150, 100, 800);
  grad.addColorStop(0, 'rgba(74, 222, 128, 0.18)');
  grad.addColorStop(1, 'rgba(74, 222, 128, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Subtle dotted texture across the canvas — keeps the empty area from
  // looking flat without dominating the image.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  for (let y = 30; y < H; y += 30) {
    for (let x = 30; x < W; x += 30) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Top-right green accent bar
  ctx.fillStyle = COLOR_GREEN;
  ctx.fillRect(0, 0, W, 6);
}

// Top-right brand mark.
function paintBrand(ctx) {
  ctx.fillStyle = COLOR_GREEN;
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('SOKOLENOK', W - 50, 70);
  ctx.fillStyle = COLOR_MUTE;
  ctx.font = '18px sans-serif';
  ctx.fillText('sokolenok.pro', W - 50, 100);
  ctx.textAlign = 'left';
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The bundled system font (DejaVu Sans on most Linux servers) lacks
// the ruble glyph ₽ — substitute "RUB" so we don't render a tofu box.
function safeCurrencyText(text) {
  if (!text) return '';
  return String(text).replace(/₽/g, ' RUB').replace(/\s+RUB/g, ' RUB');
}

// Draw an avatar circle. avatarImg may be null — we draw a placeholder.
function paintAvatarCircle(ctx, cx, cy, radius, avatarImg, fallbackLetter) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatarImg) {
    ctx.drawImage(avatarImg, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    ctx.fillStyle = COLOR_GREEN_DIM;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.fillStyle = COLOR_GREEN;
    ctx.font = `bold ${radius}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackLetter || '?').toUpperCase(), cx, cy);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  // Green ring outside the clipped circle
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
  ctx.strokeStyle = COLOR_GREEN;
  ctx.lineWidth = 4;
  ctx.stroke();
}

// Single KPI tile.
function paintKpi(ctx, x, y, w, h, label, value, valueColor) {
  roundedRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = COLOR_BG_2;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = COLOR_MUTE;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(String(label).toUpperCase(), x + 20, y + 35);

  ctx.fillStyle = valueColor || COLOR_TEXT;
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText(String(value), x + 20, y + 90);
}

async function renderProfileCard({ name, steamId, avatar, vacBanned, kd, hsPercent, hoursCs2, inventoryValueText }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paintBackground(ctx);
  paintBrand(ctx);

  // Load avatar — best effort, skip silently on failure
  let avatarImg = null;
  if (avatar) {
    try { avatarImg = await loadImage(avatar); } catch (_) { avatarImg = null; }
  }

  // Avatar circle (left)
  paintAvatarCircle(ctx, 130, 250, 95, avatarImg, (name || '?').slice(0, 1));

  // Name + steam id (right of avatar)
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText(truncate(name || 'Игрок CS2', 24), 250, 230);

  ctx.fillStyle = COLOR_DIM;
  ctx.font = '22px sans-serif';
  ctx.fillText(`Steam ID: ${steamId || '—'}`, 250, 270);

  // Optional ban badge
  if (vacBanned) {
    const badgeText = 'VAC BAN';
    ctx.font = 'bold 18px sans-serif';
    const tw = ctx.measureText(badgeText).width;
    roundedRect(ctx, 250, 290, tw + 28, 36, 8);
    ctx.fillStyle = COLOR_RED;
    ctx.fill();
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(badgeText, 264, 314);
  }

  // KPI row (bottom)
  const tileY = 400;
  const tileH = 150;
  const tileW = 250;
  const gap = 25;
  const startX = (W - (tileW * 4 + gap * 3)) / 2;

  paintKpi(ctx, startX,                        tileY, tileW, tileH, 'K/D',      kd != null ? Number(kd).toFixed(2) : '—',         null);
  paintKpi(ctx, startX + (tileW + gap),        tileY, tileW, tileH, 'HS%',      hsPercent != null ? `${Math.round(hsPercent)}%` : '—', null);
  paintKpi(ctx, startX + (tileW + gap) * 2,    tileY, tileW, tileH, 'Часов',    hoursCs2 != null ? String(Math.round(hoursCs2)) : '—', null);
  paintKpi(ctx, startX + (tileW + gap) * 3,    tileY, tileW, tileH, 'Инвентарь', safeCurrencyText(inventoryValueText) || '—', COLOR_GREEN);

  return canvas.toBuffer('image/png');
}

async function renderInventoryCard({ name, avatar, totalValueText, itemCount, currency }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paintBackground(ctx);
  paintBrand(ctx);

  let avatarImg = null;
  if (avatar) { try { avatarImg = await loadImage(avatar); } catch (_) {} }

  paintAvatarCircle(ctx, 100, 200, 70, avatarImg, (name || '?').slice(0, 1));

  ctx.fillStyle = COLOR_TEXT;
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(truncate(name || 'Игрок', 30), 200, 180);

  ctx.fillStyle = COLOR_MUTE;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('ИНВЕНТАРЬ CS2', 200, 215);

  // Big total value
  ctx.fillStyle = COLOR_GREEN;
  ctx.font = 'bold 120px sans-serif';
  const valueText = safeCurrencyText(totalValueText) || '—';
  ctx.fillText(valueText, 80, 420);

  // "X предметов"
  ctx.fillStyle = COLOR_DIM;
  ctx.font = '28px sans-serif';
  ctx.fillText(`${itemCount || 0} предметов${currency ? ` · ${currency}` : ''}`, 80, 470);

  return canvas.toBuffer('image/png');
}

async function renderPostCard({ publicName, title, body, image, publicAvatar }) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paintBackground(ctx);
  paintBrand(ctx);

  // Public name + avatar at top
  let avatarImg = null;
  if (publicAvatar) { try { avatarImg = await loadImage(publicAvatar); } catch (_) {} }
  paintAvatarCircle(ctx, 90, 190, 40, avatarImg, (publicName || '?').slice(0, 1));

  ctx.fillStyle = COLOR_DIM;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(truncate(publicName || 'SOKOLENOK', 40), 150, 200);

  // Title (large, wraps to 2 lines max)
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = 'bold 48px sans-serif';
  const titleText = title || '';
  wrapText(ctx, titleText, 80, 290, W - 160, 60, 2);

  // Body preview (3 lines)
  if (body) {
    ctx.fillStyle = COLOR_DIM;
    ctx.font = '24px sans-serif';
    const cleanBody = String(body).replace(/<[^>]+>/g, '').trim();
    wrapText(ctx, cleanBody, 80, 450, W - 160, 32, 3);
  }

  return canvas.toBuffer('image/png');
}

// Word-wrap helper. Stops after maxLines, appending "…" if truncated.
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '';
  let lineCount = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lineCount * lineHeight);
      lineCount++;
      line = words[i];
      if (lineCount >= maxLines - 1) {
        // Last line — append "…" if more text remains
        let remaining = words.slice(i).join(' ');
        while (ctx.measureText(remaining + '…').width > maxWidth && remaining.length > 1) {
          remaining = remaining.slice(0, -1);
        }
        ctx.fillText(remaining + '…', x, y + lineCount * lineHeight);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lineCount * lineHeight);
}

module.exports = {
  renderProfileCard,
  renderInventoryCard,
  renderPostCard
};

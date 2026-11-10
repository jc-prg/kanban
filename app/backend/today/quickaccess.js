'use strict';
// "Today" Quick access widget: discovers a site's best app icon / favicon, downloads it once and
// stores it under TODAY_ICONS_DIR with a content-addressed name (qa-<sha1/16>.<ext>), so the
// browser can cache it forever and the target site is never asked again.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { TODAY_ICONS_DIR } = require('../config');
const { QA_ICON_FILE }    = require('../schemas');

const TIMEOUT_MS   = 10_000;
const MAX_HTML     = 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;
const MAX_ICON     = 512 * 1024;
const MAX_TRIES    = 6;              // candidates downloaded before giving up
const PRUNE_GRACE  = 60 * 60 * 1000; // fetched but not yet saved in the config — keep for an hour
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * Response body as a Buffer, at most `max` bytes. Larger bodies throw 413 — or, with `truncate`
 * (page HTML: the icon links are in <head>), end at `max` bytes and the download is cancelled.
 */
async function _readLimited(res, max, truncate = false) {
  const len = Number(res.headers.get('content-length'));
  if (len > max && !truncate) throw httpError(413, 'too large');
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    if (total + buf.length > max) {
      if (!truncate) throw httpError(413, 'too large');
      chunks.push(buf.subarray(0, max - total));
      break;   // leaving the loop cancels the stream
    }
    total += buf.length;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function _get(url, accept, max, truncate = false) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw httpError(502, `HTTP ${res.status}`);
  return { url: res.url || url, type: res.headers.get('content-type') || '', body: await _readLimited(res, max, truncate) };
}

/** File extension from the magic bytes, or null when the buffer is no supported image. Pure. */
function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2048)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function _attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&').trim();
  }
  return out;
}

/** Largest edge from a `sizes` attribute ("16x16 32x32", "any"); `any` = vector. Pure. */
function _maxSize(sizes) {
  if (!sizes) return 0;
  if (/\bany\b/i.test(sizes)) return SVG_SCORE;   // only vector icons declare "any"
  return Math.max(0, ...[...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map(m => Math.min(+m[1], +m[2])));
}

const _isSvg = (href, type) => /svg/i.test(type || '') || /\.svg(?:[?#]|$)/i.test(href || '');

// SVG favicons are mostly tab-bar glyphs (monochrome, made for a light tab) — large raster app
// icons (apple-touch, manifest) look better as launcher icons, small raster favicons worse.
const SVG_SCORE = 120;

/**
 * Icon candidates from a page's HTML, best first by declared size (apple-touch icons default to
 * 180, plain icons to 32 / 16 for .ico, SVG = SVG_SCORE); /apple-touch-icon.png and /favicon.ico
 * as fallbacks. Returns `{ candidates: [{ url, score }], manifest }`. Pure.
 */
function parseIconLinks(html, baseUrl) {
  const found = [];
  let manifest = null;
  const abs = href => { try { return new URL(href, baseUrl).href; } catch { return null; } };
  // <base href> changes how relative icon URLs resolve
  const baseTag = /<base\b[^>]*>/i.exec(html || '');
  if (baseTag) { const b = abs(_attrs(baseTag[0]).href || ''); if (b) baseUrl = b; }
  for (const [tag] of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const a = _attrs(tag);
    const rel = (a.rel || '').toLowerCase().split(/\s+/);
    if (!a.href) continue;
    if (rel.includes('manifest')) { manifest = manifest || abs(a.href); continue; }
    const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!apple && !rel.includes('icon')) continue;   // mask-icon is monochrome — not used
    const url = a.href.startsWith('data:') ? a.href : abs(a.href);
    if (!url) continue;
    let score = _maxSize(a.sizes);
    if (_isSvg(a.href, a.type)) score = SVG_SCORE;
    else if (!score) score = apple ? 180 : /\.ico(?:[?#]|$)/i.test(a.href) ? 16 : 32;
    found.push({ url, score });
  }
  const origin = abs('/');
  if (origin) {
    found.push({ url: abs('/apple-touch-icon.png'), score: 150 });
    found.push({ url: abs('/favicon.ico'), score: 8 });
  }
  return { candidates: _rank(found), manifest };
}

function _rank(list) {
  const seen = new Set();
  return list.filter(c => !seen.has(c.url) && seen.add(c.url)).sort((a, b) => b.score - a.score);
}

/** Icon candidates from a web app manifest (`icons[]`); maskable-only icons rank lower. Pure. */
function parseManifestIcons(json, baseUrl) {
  const icons = Array.isArray(json?.icons) ? json.icons : [];
  return icons.flatMap(i => {
    if (!i || typeof i.src !== 'string') return [];
    let url;
    try { url = new URL(i.src, baseUrl).href; } catch { return []; }
    let score = _isSvg(i.src, i.type) ? SVG_SCORE : _maxSize(i.sizes) || 48;
    if (/maskable/.test(i.purpose || '') && !/any/.test(i.purpose || '')) score = Math.min(score, 100);
    return [{ url, score }];
  });
}

/** Ranked icon candidates for a web page (page HTML + manifest + well-known fallbacks). */
async function discoverIcons(pageUrl) {
  let html = '', base = pageUrl;
  try {
    const page = await _get(pageUrl, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', MAX_HTML, true);
    base = page.url;
    if (/html|xml/i.test(page.type) || !page.type) html = page.body.toString('utf8');
  } catch { /* unreachable / login page — the fallbacks may still work */ }
  const { candidates, manifest } = parseIconLinks(html, base);
  if (!manifest) return candidates;
  try {
    const m = await _get(manifest, 'application/manifest+json,application/json;q=0.9,*/*;q=0.5', MAX_MANIFEST);
    return _rank([...candidates, ...parseManifestIcons(JSON.parse(m.body.toString('utf8')), m.url)]);
  } catch { return candidates; }
}

function _decodeDataUrl(url) {
  const m = /^data:image\/[\w.+-]+(;[^,]*)?,(.*)$/is.exec(url);
  if (!m) return null;
  return /;base64/i.test(m[1] || '') ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'utf8');
}

/** Store an image buffer; returns `{ file }`. 415 when it is no supported image. */
async function saveIcon(buf) {
  if (!buf?.length || buf.length > MAX_ICON) throw httpError(413, 'Image too large (max 512 KB)');
  const ext = sniffImage(buf);
  if (!ext) throw httpError(415, 'Not a supported image (PNG, JPEG, GIF, WebP, ICO, SVG)');
  const file = `qa-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  await fs.promises.mkdir(TODAY_ICONS_DIR, { recursive: true });
  const dest = path.join(TODAY_ICONS_DIR, file);
  if (fs.existsSync(dest)) await fs.promises.utimes(dest, new Date(), new Date());   // restart the prune grace
  else await fs.promises.writeFile(dest, buf);
  return { file };
}

/** Find, download and store the best icon of `pageUrl`. 502 when none could be loaded. */
async function fetchIcon(pageUrl) {
  if (!/^https?:\/\/\S+$/i.test(pageUrl || '')) throw httpError(400, 'url must be an http(s) URL');
  const candidates = await discoverIcons(pageUrl);
  for (const c of candidates.slice(0, MAX_TRIES)) {
    let buf = null;
    try {
      buf = c.url.startsWith('data:') ? _decodeDataUrl(c.url) : (await _get(c.url, 'image/*,*/*;q=0.5', MAX_ICON)).body;
    } catch { continue; }   // next candidate
    if (buf && sniffImage(buf)) return saveIcon(buf);   // storage errors are not "no icon"
  }
  throw httpError(502, 'No icon found for this address');
}

/** Delete stored icons that no entry references (older than PRUNE_GRACE). Returns the deleted names. */
async function pruneIcons(config, now = Date.now()) {
  const used = new Set((config?.widgets?.quickaccess?.items || [])
    .map(i => i?.icon?.type === 'image' ? i.icon.file : null).filter(Boolean));
  let names;
  try { names = await fs.promises.readdir(TODAY_ICONS_DIR); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!QA_ICON_FILE.test(name) || used.has(name)) continue;
    const p = path.join(TODAY_ICONS_DIR, name);
    try {
      if (now - (await fs.promises.stat(p)).mtimeMs < PRUNE_GRACE) continue;
      await fs.promises.unlink(p);
      removed.push(name);
    } catch { /* ignore */ }
  }
  return removed;
}

module.exports = {
  sniffImage, parseIconLinks, parseManifestIcons, discoverIcons, fetchIcon, saveIcon, pruneIcons,
  MAX_ICON, PRUNE_GRACE,
};

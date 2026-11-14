// Mail HTML → Markdown for cards created from a mail (_createCardFromMail in dashboard.js), so the card
// description looks like the mail: paragraphs, line breaks, headings, bold / italic / strike, links,
// lists, quotes (replies), code, rules and data tables. Layout tables (newsletters) are flattened to
// their cells; inline images of the mail (<img src="cid:…">) become `![name](attachment:name)` at their
// place — the attachments are copied to the card — while remote images are left out (they would load
// in the card — tracking); hidden elements, styles and scripts are dropped. Pure apart from DOMParser.

const _MD_BLOCK = '\u0002';   // block boundary while converting
const _MD_DONE  = '\u0003';   // start of a block that is already finished Markdown
const _MD_BR    = '\u0001';   // <br>

const _MD_SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'template', 'svg',
  'picture', 'video', 'audio', 'iframe', 'object', 'embed', 'canvas', 'map', 'button', 'input', 'select', 'textarea', 'form']);
const _MD_BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center',
  'address', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'details', 'summary', 'fieldset', 'body', 'html', 'font-block']);

/** Name a card attachment is stored under — same rule as `_safeFilePart` in backend/routes/attachments.js. */
function _mailAttachName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._\- ]/g, '_').replace(/\s+/g, '_').replace(/^\./, '_').slice(0, 200) || 'file';
}

/** Markdown that embeds a card attachment image. */
function _mdAttachImage(name) {
  const file = _mailAttachName(name);
  return `![${file}](attachment:${file})`;
}

/** Characters that would end a link target / autolink, percent-encoded. */
function _mdUrl(url, chars) {
  return url.replace(chars, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Text that Markdown would read as formatting / HTML, escaped. */
function _mdEscape(text) {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

function _mdHidden(el) {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' && !el.textContent.trim()) return true;
  const style = (el.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden|mso-hide:all|max-height:0(px)?(;|$)/.test(style);
}

/** Wrap inline content in a marker (`**`, `*`, `~~`), spaces kept outside — Markdown needs that. */
function _mdWrap(inner, mark) {
  if (inner.includes(_MD_BLOCK)) return inner;   // blocks inside <b> etc.: no emphasis across them
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function _mdBlock(md) {
  return md ? `${_MD_BLOCK}${_MD_DONE}${md}${_MD_BLOCK}` : _MD_BLOCK;
}

/** A table with data (≥ 2 rows and columns, no nested tables, short one-line cells) — else layout. */
function _mdDataRows(table) {
  if (table.querySelector('table')) return null;
  const rows = [...table.rows].filter(r => !_mdHidden(r) && r.cells.length);
  if (rows.length < 2) return null;
  const cells = rows.map(r => [...r.cells]);
  const cols = Math.max(...cells.map(c => c.length));
  if (cols < 2 || cols > 8) return null;
  if (cells.some(c => c.some(td => td.textContent.trim().length > 200 || td.querySelector('p, div, ul, ol, blockquote, br')))) return null;
  return cells;
}

function _mdTable(table, ctx) {
  const rows = _mdDataRows(table);
  if (!rows) return [...table.rows].map(r => [...r.cells].map(td => _MD_BLOCK + _mdChildren(td, ctx) + _MD_BLOCK).join('')).join('');
  const cols = Math.max(...rows.map(r => r.length));
  const line = r => `| ${Array.from({ length: cols }, (_, i) =>
    r[i] ? _mdFinish(_mdChildren(r[i], ctx)).replace(/\n+/g, ' ') : '').join(' | ')} |`;
  return _mdBlock([line(rows[0]), `|${' --- |'.repeat(cols)}`, ...rows.slice(1).map(line)].join('\n'));
}

function _mdList(list, ctx) {
  const ordered = list.tagName.toLowerCase() === 'ol';
  let n = Number(list.getAttribute('start')) || 1;
  const items = [];
  for (const li of list.children) {
    if (li.tagName.toLowerCase() !== 'li' || _mdHidden(li)) continue;
    const marker = ordered ? `${n++}. ` : '- ';
    // A nested list follows the item's text directly (tight list)
    const body = (_mdFinish(_mdChildren(li, ctx)) || '').replace(/\n\n(?=(?:- |\d+\. ))/g, '\n');
    const pad = ' '.repeat(marker.length);
    items.push(marker + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n'));
  }
  return _mdBlock(items.join('\n'));
}

function _mdChildren(node, ctx) {
  let out = '';
  for (const child of node.childNodes) out += _mdNode(child, ctx);
  return out;
}

function _mdNode(node, ctx) {
  if (node.nodeType === 3) return _mdEscape(node.nodeValue.replace(/[\s ]+/g, ' '));
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (_MD_SKIP.has(tag) || _mdHidden(node)) return '';
  switch (tag) {
    case 'br': return _MD_BR;
    case 'img': {
      // Inline image of the mail (Content-ID) → the attachment copied to the card; remote ones dropped
      const src = (node.getAttribute('src') || '').trim();
      const name = /^cid:/i.test(src) ? ctx.cids?.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase()) : null;
      if (!name) return '';
      ctx.used?.add(name);
      return _mdAttachImage(name);
    }
    case 'hr': return _mdBlock('---');
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const text = _mdFinish(_mdChildren(node, ctx)).replace(/\n+/g, ' ');
      return text ? _mdBlock(`${'#'.repeat(Number(tag[1]))} ${text}`) : _MD_BLOCK;
    }
    case 'b': case 'strong':
      return ctx.bold ? _mdChildren(node, ctx) : _mdWrap(_mdChildren(node, { ...ctx, bold: true }), '**');
    case 'i': case 'em': case 'cite': case 'var':
      return ctx.italic ? _mdChildren(node, ctx) : _mdWrap(_mdChildren(node, { ...ctx, italic: true }), '*');
    case 's': case 'strike': case 'del':
      return _mdWrap(_mdChildren(node, ctx), '~~');
    case 'code': case 'kbd': case 'samp': {
      const t = node.textContent.replace(/\s+/g, ' ');
      if (!t.trim()) return t;
      const fence = t.includes('`') ? '``' : '`';
      return `${fence}${fence.length > 1 ? ' ' : ''}${t}${fence.length > 1 ? ' ' : ''}${fence}`;
    }
    case 'pre': {
      const t = node.textContent.replace(/\n$/, '');
      return t.trim() ? _mdBlock('```\n' + t.replace(/```/g, '``​`') + '\n```') : '';
    }
    case 'a': {
      const inner = _mdChildren(node, ctx);
      const href = (node.getAttribute('href') || '').trim();
      if (!/^(https?:|mailto:)/i.test(href) || inner.includes(_MD_BLOCK)) return inner;
      const text = inner.replace(new RegExp(_MD_BR, 'g'), ' ').trim();
      if (!text) return '';   // linked images (logos, buttons)
      const plain = node.textContent.trim();
      if (plain === href || `mailto:${plain}` === href) return `<${_mdUrl(href, /[<>\s]/g)}>`;
      return `[${text}](${_mdUrl(href, /[()\s<>]/g)})`;
    }
    case 'blockquote': {
      const body = _mdFinish(_mdChildren(node, ctx));
      return body ? _mdBlock(body.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')) : '';
    }
    case 'ul': case 'ol': return _mdList(node, ctx);
    case 'li': return _MD_BLOCK + _mdChildren(node, ctx) + _MD_BLOCK;   // stray <li> outside a list
    case 'table': return _MD_BLOCK + _mdTable(node, ctx) + _MD_BLOCK;
    case 'tr': case 'td': case 'th': case 'tbody': case 'thead': case 'tfoot':
      return _MD_BLOCK + _mdChildren(node, ctx) + _MD_BLOCK;
  }
  return _MD_BLOCKS.has(tag) ? _MD_BLOCK + _mdChildren(node, ctx) + _MD_BLOCK : _mdChildren(node, ctx);
}

/** Converted content → Markdown text: paragraphs separated by a blank line, <br> = hard break. */
function _mdFinish(s) {
  const paras = [];
  for (const chunk of s.split(_MD_BLOCK)) {
    if (chunk.startsWith(_MD_DONE)) { const md = chunk.slice(1).replace(/\s+$/, ''); if (md) paras.push(md); continue; }
    let lines = [];
    const flush = () => { if (lines.length) paras.push(lines.join('  \n')); lines = []; };
    for (const raw of chunk.split(_MD_BR)) {
      const line = raw.replace(/ {2,}/g, ' ').trim()
        // Line starts Markdown would read as a heading / list / quote / rule
        .replace(/^(#{1,6}(?=\s|$)|[-+](?=\s)|\d+(?=[.)]\s)|=+$|-{3,}$)/, '\\$1');
      if (line) lines.push(line);
      else flush();   // two <br> in a row = new paragraph
    }
    flush();
  }
  return paras.join('\n\n');
}

/**
 * Mail HTML → Markdown (empty string for nothing readable). `attachments` = the mail's attachments
 * ({ name, cid? }): images referenced by Content-ID are embedded where the mail shows them; `used`
 * (a Set) collects their names.
 */
function _mailHtmlToMarkdown(html, { attachments = [], used = null } = {}) {
  const cids = new Map(attachments.filter(a => a.cid).map(a => [String(a.cid).replace(/^<|>$/g, '').toLowerCase(), a.name]));
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return _mdFinish(_mdChildren(doc.body, { cids, used })).replace(/\n{3,}/g, '\n\n').trim();
}

// Image types browsers show — other attachments stay plain card attachments
const _MD_IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/i;

/** Embedded images for the image attachments not shown in the body yet (plain-text mails, images only attached). */
function _mailImageAttachmentsMd(attachments, used = new Set()) {
  return attachments.filter(a => _MD_IMAGE_TYPES.test(a.type || '') && !used.has(a.name))
    .map(a => _mdAttachImage(a.name)).join('\n\n');
}

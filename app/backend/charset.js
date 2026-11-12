'use strict';
// Text decoding for content from other servers (mail parts, calendar feeds), which often isn't UTF-8:
// "Dank f\xfcr" in ISO-8859-1 / windows-1252 read as UTF-8 turns into "Dank f�r".

const _UTF8 = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/** Charset parameter of a Content-Type value, lower-cased, or ''. */
function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Bytes → string. A declared charset other than UTF-8 is used as given (TextDecoder knows the WHATWG
 * encodings; ISO-8859-1 maps to windows-1252 there, a superset). UTF-8 — declared or not — is checked:
 * invalid bytes mean a mislabelled legacy text, decoded as windows-1252 instead of producing U+FFFD.
 */
function decodeText(buf, charset = '') {
  if (!buf) return '';
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const cs = String(charset || '').trim().toLowerCase();
  if (cs && !_UTF8.has(cs)) {
    try { return new TextDecoder(cs).decode(bytes); } catch { /* unknown charset — guess below */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Body of a fetch() Response decoded like decodeText (charset from its Content-Type). */
async function responseText(res) {
  if (typeof res.arrayBuffer !== 'function') return res.text();   // minimal stand-ins (tests)
  return decodeText(Buffer.from(await res.arrayBuffer()), charsetFromContentType(res.headers?.get?.('content-type')));
}

module.exports = { decodeText, charsetFromContentType, responseText };

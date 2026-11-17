// Uploaded files in a card / note description: non-image files go into a list at the end of the
// text — a "---" line followed by one "- [name](link)" item per file (created on the first upload,
// extended afterwards); images go to the last cursor position of the edit mode, else above that
// list (else at the end). Pure; used by addAttachmentLink in editor.js. Unit AL-1..AL-4.

const _ATTACH_ITEM_RE = /^\s*[-*+] !?\[.*\]\(.*\)\s*$/;

/** The trailing attachment list: { start (of the "---" line), end (after the last item) } or null. */
function _attachListRange(text) {
  const lines = text.split('\n');
  const starts = [];
  let p = 0;
  for (const l of lines) { starts.push(p); p += l.length + 1; }
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const last = i;
  while (i >= 0 && _ATTACH_ITEM_RE.test(lines[i])) i--;
  if (i === last || i < 0 || lines[i].trim() !== '---') return null;
  return { start: starts[i], end: starts[last] + lines[last].length };
}

/**
 * The edit that adds an uploaded file's Markdown `md` to `text`: { from, to, insert, cursor } or
 * null (the file is listed already). `cursor` = last cursor position of the edit mode (null = none);
 * the returned `cursor` is that position after the edit (an image placed there: after the image).
 */
function _attachmentEdit(text, md, { image = false, cursor = null } = {}) {
  const list = _attachListRange(text);
  const shift = (from, to, insert) => {
    const c = cursor === null || cursor <= from ? cursor : cursor + insert.length - (to - from);
    return { from, to, insert, cursor: c };
  };
  if (!image) {
    const item = `- ${md}`;
    if (list) {
      if (text.slice(list.start, list.end).split('\n').some(l => l.trim() === item)) return null;
      return shift(list.end, list.end, `\n${item}`);
    }
    const body = text.replace(/\s+$/, '');
    return shift(body.length, text.length, `${body ? '\n\n' : ''}---\n${item}`);
  }
  if (cursor !== null && (!list || cursor < list.start)) {
    // always on a line of its own
    const at = Math.max(0, Math.min(cursor, text.length));
    const pre  = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
    const post = at < text.length && text[at] !== '\n' ? '\n' : '';
    return { from: at, to: at, insert: `${pre}${md}${post}`, cursor: at + pre.length + md.length };
  }
  if (list) {
    const before = text.slice(0, list.start);
    const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const r = shift(list.start, list.start, `${pre}${md}\n\n`);
    if (cursor !== null) r.cursor = list.start + pre.length + md.length;
    return r;
  }
  const body = text.replace(/\s+$/, '');
  return shift(body.length, text.length, `${body ? '\n\n' : ''}${md}`);
}

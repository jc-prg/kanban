import {
  EditorView,
  EditorState,
  Decoration,
  ViewPlugin,
  RangeSetBuilder,
  keymap,
  drawSelection,
  highlightActiveLine,
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  history,
  historyKeymap,
  defaultKeymap,
  markdown,
  tags,
  GFM,
} from '/vendor-libs/codemirror-bundle.js';

// ---- syntax highlight style (adapts to app dark/light theme) ----
const _darkStyle = HighlightStyle.define([
  { tag: tags.heading1, color: '#ffffff', fontWeight: 'bold', fontSize: '1.3em',  fontFamily: "'Syne', sans-serif" },
  { tag: tags.heading2, color: '#ffffff', fontWeight: 'bold', fontSize: '1.15em', fontFamily: "'Syne', sans-serif" },
  { tag: tags.heading3, color: '#ffffff', fontWeight: 'bold',                     fontFamily: "'Syne', sans-serif" },
  { tag: tags.strong,         color: '#f2f2fa', fontWeight: 'bold' },
  { tag: tags.emphasis,       color: '#d4cfff', fontStyle: 'italic' },
  { tag: tags.strikethrough,  color: '#9090b0', textDecoration: 'line-through' },
  { tag: tags.link,           color: '#7c6af7', textDecoration: 'underline' },
  { tag: tags.url,            color: '#7c6af7' },
  { tag: tags.monospace,      color: '#a8d8a8', fontFamily: "'DM Mono', monospace" },
  { tag: tags.meta,           color: '#9090b0' },
  { tag: tags.processingInstruction, color: '#9090b0' },
  { tag: tags.punctuation,    color: '#6060a0' },
  { tag: tags.quote,          color: '#c4b5fd', fontStyle: 'italic' },
  { tag: tags.list,           color: 'inherit' },
]);

const _lightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: '#1a1a2e', fontWeight: 'bold', fontSize: '1.3em',  fontFamily: "'Syne', sans-serif" },
  { tag: tags.heading2, color: '#1a1a2e', fontWeight: 'bold', fontSize: '1.15em', fontFamily: "'Syne', sans-serif" },
  { tag: tags.heading3, color: '#1a1a2e', fontWeight: 'bold',                     fontFamily: "'Syne', sans-serif" },
  { tag: tags.strong,         color: '#1a1a2e', fontWeight: 'bold' },
  { tag: tags.emphasis,       color: '#2a1a6e', fontStyle: 'italic' },
  { tag: tags.strikethrough,  color: '#707088', textDecoration: 'line-through' },
  { tag: tags.link,           color: '#5b4de0', textDecoration: 'underline' },
  { tag: tags.url,            color: '#5b4de0' },
  { tag: tags.monospace,      color: '#1a6b1a', fontFamily: "'DM Mono', monospace" },
  { tag: tags.meta,           color: '#707088' },
  { tag: tags.processingInstruction, color: '#707088' },
  { tag: tags.punctuation,    color: '#9090b0' },
  { tag: tags.quote,          color: '#4a3ddb', fontStyle: 'italic' },
  { tag: tags.list,           color: 'inherit' },
]);

function _highlightExtension() {
  const dark  = window.matchMedia('(prefers-color-scheme: dark)');
  // App default is dark; light only when media query explicitly matches light
  const light = window.matchMedia('(prefers-color-scheme: light)');
  return syntaxHighlighting(light.matches ? _lightStyle : _darkStyle, { fallback: true });
}

// ---- registry ----
const _editors = new Map(); // id → { view, preview, editorWrap }

// ---- <u>underline</u> ViewPlugin ----
const _ulMark = Decoration.mark({ class: 'cm-underline' });

function _buildUlDecorations(view) {
  const builder = new RangeSetBuilder();
  const re = /<u>([^<\n]*)<\/u>/g;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      builder.add(from + m.index, from + m.index + m[0].length, _ulMark);
    }
  }
  return builder.finish();
}

const _ulPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = _buildUlDecorations(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = _buildUlDecorations(u.view);
    }
  },
  { decorations: v => v.decorations }
);

// ---- ==highlight== ViewPlugin ----
const _hlMark = Decoration.mark({ class: 'cm-highlight' });

function _buildHlDecorations(view) {
  const builder = new RangeSetBuilder();
  const re = /==([^=\n]+)==/g;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      builder.add(from + m.index, from + m.index + m[0].length, _hlMark);
    }
  }
  return builder.finish();
}

const _hlPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = _buildHlDecorations(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = _buildHlDecorations(u.view);
    }
  },
  { decorations: v => v.decorations }
);

// ---- preview helpers ----

// Walk src and rendered in parallel, advancing src for markdown-syntax chars that have
// no counterpart in rendered text. Returns the src index corresponding to renderedPrefix.length.
function _alignToSource(src, renderedPrefix) {
  let si = 0, ri = 0;
  while (ri < renderedPrefix.length && si < src.length) {
    if (src[si] === renderedPrefix[ri]) { si++; ri++; }
    else si++;
  }
  return si;
}

// After rendering, stamp data-sc (source char offset) and data-sc-len on each direct-child
// block element and on direct <li> children of lists.
function _annotateBlocks(el, text) {
  if (!window.marked) return;
  const tokens = marked.lexer(text);
  const infos = [];
  let pos = 0;
  for (const token of tokens) {
    if (token.type !== 'space') {
      infos.push({ pos, len: token.raw.length });
      if (token.items) {
        let iPos = pos;
        for (const item of token.items) {
          infos.push({ pos: iPos, len: item.raw.length });
          iPos += item.raw.length;
        }
      }
    }
    pos += token.raw.length;
  }
  let idx = 0;
  for (const child of el.children) {
    if (idx >= infos.length) break;
    const info = infos[idx++];
    child.dataset.sc = info.pos;
    child.dataset.scLen = info.len;
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      for (const li of child.querySelectorAll(':scope > li')) {
        if (idx >= infos.length) break;
        const linfo = infos[idx++];
        li.dataset.sc = linfo.pos;
        li.dataset.scLen = linfo.len;
      }
    }
  }
}

function _enhanceCheckboxes(entry) {
  entry.preview.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.removeAttribute('disabled');
    cb.addEventListener('click', e => {
      e.stopPropagation();
      const text = entry.view.state.doc.toString();
      const matches = [...text.matchAll(/^(\s*[-*+]\s+)\[([ x])\]/gim)];
      if (i >= matches.length) return;
      const match = matches[i];
      const pos = match.index + match[1].length + 1; // position of ' ' or 'x'
      entry.view.dispatch({ changes: { from: pos, to: pos + 1, insert: match[2] === 'x' ? ' ' : 'x' } });
      _renderPreview(entry, entry.view.state.doc.toString());
    });
  });
}

function _renderPreview(entry, text) {
  const el = entry.preview;
  if (!text || !text.trim()) {
    el.innerHTML = '';
    el.classList.add('cm-preview--empty');
    return;
  }
  el.classList.remove('cm-preview--empty');
  const raw = window.marked ? window.marked.parse(text) : text.replace(/\n/g, '<br>');
  const opts = Object.assign({ ADD_ATTR: ['target'] }, entry.sanitizeOpts);
  el.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(raw, opts) : raw;
  if (window.buildToc) window.buildToc(el);
  if (entry.onPreview) entry.onPreview(el);
  _annotateBlocks(el, text);
  _enhanceCheckboxes(entry);
}

// srcPos: char offset in source to place cursor (optional).
// viewFraction: 0–1 — where in the editor viewport the cursor should appear (optional).
function _activateEditor(id, srcPos, viewFraction) {
  const entry = _editors.get(id);
  if (!entry) return;
  entry.preview.style.display = 'none';
  entry.editorWrap.style.display = '';

  if (srcPos !== undefined) {
    const clampedPos = Math.max(0, Math.min(entry.view.state.doc.length, srcPos));
    entry.view.dispatch({ selection: { anchor: clampedPos } });
    requestAnimationFrame(() => {
      const scroller = entry.view.scrollDOM;
      const cursorCoords = entry.view.coordsAtPos(clampedPos);
      if (cursorCoords && viewFraction !== undefined) {
        const editorRect = scroller.getBoundingClientRect();
        const targetY = editorRect.top + viewFraction * scroller.clientHeight;
        scroller.scrollTop += cursorCoords.top - targetY;
      }
    });
  }

  entry.view.focus();
}

function _deactivateEditor(id) {
  const entry = _editors.get(id);
  if (!entry) return;
  _renderPreview(entry, entry.view.state.doc.toString());
  entry.editorWrap.style.display = 'none';
  entry.preview.style.display = '';
}

// ---- internal helpers ----
function _wrapSel(view, open, close) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  const insert = open + selected + close;
  view.dispatch({
    changes: { from, to, insert },
    selection: selected ? { anchor: from, head: from + insert.length }
                        : { anchor: from + open.length },
  });
  view.focus();
}

function _linePrefix(view, prefix) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
  view.focus();
}

function _insertBlock(view, text, cursorOffset) {
  const { from } = view.state.selection.main;
  const doc = view.state.doc.toString();
  const needNl = from > 0 && doc[from - 1] !== '\n';
  const insert = (needNl ? '\n' : '') + text;
  const anchor = from + (needNl ? 1 : 0) + cursorOffset;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: { anchor },
  });
  view.focus();
}

// ---- public API ----

function createMarkdownEditor(id, { onChange, onPreview, sanitizeOpts } = {}) {
  if (_editors.has(id)) return _editors.get(id).view;
  const mount  = document.getElementById(id + '-mount');
  const mirror = document.getElementById(id); // hidden textarea
  if (!mount) return null;

  // Preview pane — shown by default, click to edit
  const preview = document.createElement('div');
  preview.className = 'cm-preview card-desc-preview';
  mount.appendChild(preview);

  // Editor wrapper — hidden until activated
  const editorWrap = document.createElement('div');
  editorWrap.className = 'cm-editor-wrap';
  editorWrap.style.display = 'none';
  mount.appendChild(editorWrap);

  const view = new EditorView({
    state: EditorState.create({
      doc: mirror?.value || '',
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        _highlightExtension(),
        indentOnInput(),
        bracketMatching(),
        markdown({ extensions: GFM }),
        EditorView.lineWrapping,
        _ulPlugin,
        _hlPlugin,
        keymap.of([
          ...historyKeymap,
          ...defaultKeymap,
          { key: 'Ctrl-b', run: v => { _wrapSel(v, '**', '**');     return true; } },
          { key: 'Ctrl-i', run: v => { _wrapSel(v, '*', '*');       return true; } },
          { key: 'Ctrl-u', run: v => { _wrapSel(v, '<u>', '</u>');  return true; } },
          { key: 'Ctrl-m', run: v => { _wrapSel(v, '==', '==');     return true; } },
        ]),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          const val = update.state.doc.toString();
          if (mirror) mirror.value = val;
          if (onChange) onChange(val);
        }),
      ],
    }),
    parent: editorWrap,
  });

  const entry = { view, preview, editorWrap, onPreview, sanitizeOpts };
  _editors.set(id, entry);

  // Render initial preview
  _renderPreview(entry, mirror?.value || '');

  // Click preview → switch to editor, placing cursor at the clicked position
  preview.addEventListener('click', e => {
    const previewRect = preview.getBoundingClientRect();
    const viewFraction = Math.max(0, Math.min(1, (e.clientY - previewRect.top) / preview.clientHeight));

    // Resolve exact caret position (Chrome/Safari vs Firefox API)
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? (() => {
      if (!document.caretPositionFromPoint) return null;
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      return p ? { startContainer: p.offsetNode, startOffset: p.offset } : null;
    })();

    let srcPos;
    if (caret) {
      const { startContainer: node, startOffset: offset } = caret;
      // Walk up DOM to nearest block annotated with data-sc
      let blockEl = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      while (blockEl && blockEl !== preview && blockEl.dataset.sc === undefined) {
        blockEl = blockEl.parentElement;
      }
      if (blockEl && blockEl !== preview && blockEl.dataset.sc !== undefined) {
        const srcStart = +blockEl.dataset.sc;
        const src = entry.view.state.doc.sliceString(srcStart, srcStart + +blockEl.dataset.scLen);
        // Collect rendered text from block start up to the click point
        let renderedPrefix = '';
        const tw = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
        let tNode;
        while ((tNode = tw.nextNode())) {
          if (tNode === node) { renderedPrefix += tNode.textContent.slice(0, offset); break; }
          renderedPrefix += tNode.textContent;
        }
        srcPos = srcStart + _alignToSource(src, renderedPrefix);
      }
    }

    _activateEditor(id, srcPos, viewFraction);
  });

  // Focus leaves editorWrap → switch back to preview
  editorWrap.addEventListener('focusout', e => {
    if (!editorWrap.contains(e.relatedTarget)) _deactivateEditor(id);
  });

  return view;
}

function getEditorValue(id) {
  const entry = _editors.get(id);
  if (entry) return entry.view.state.doc.toString();
  return document.getElementById(id)?.value ?? '';
}

function setEditorValue(id, text) {
  const entry = _editors.get(id);
  if (entry) {
    entry.view.dispatch({ changes: { from: 0, to: entry.view.state.doc.length, insert: text } });
    _renderPreview(entry, text);
    // Return to preview mode when value is set programmatically
    entry.editorWrap.style.display = 'none';
    entry.preview.style.display = '';
    return;
  }
  const el = document.getElementById(id);
  if (el) el.value = text;
}

function insertAtCursor(id, text) {
  const entry = _editors.get(id);
  if (!entry) return;
  _activateEditor(id);
  const { from, to } = entry.view.state.selection.main;
  entry.view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  entry.view.focus();
}

function focusEditor(id) {
  _activateEditor(id);
}

function applyEditorFormat(id, action) {
  const entry = _editors.get(id);
  if (!entry) return;
  _activateEditor(id);
  const view = entry.view;

  if (action === 'bold')          return _wrapSel(view, '**', '**');
  if (action === 'italic')        return _wrapSel(view, '*', '*');
  if (action === 'underline')     return _wrapSel(view, '<u>', '</u>');
  if (action === 'mark')          return _wrapSel(view, '==', '==');
  if (action === 'strikethrough') return _wrapSel(view, '~~', '~~');
  if (action === 'h1')            return _linePrefix(view, '# ');
  if (action === 'h2')            return _linePrefix(view, '## ');
  if (action === 'h3')            return _linePrefix(view, '### ');
  if (action === 'checkbox') {
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const prefix = '- [ ] ';
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: prefix },
      selection: { anchor: line.from + prefix.length },
    });
    view.focus();
    return;
  }
  if (action === 'code') {
    const { from, to } = view.state.selection.main;
    if (from !== to) return _wrapSel(view, '```\n', '\n```');
    return _insertBlock(view, '```\n\n```', 4);
  }
  if (action === 'toc')           return _insertBlock(view, '[toc]', 5);
  if (action === 'subpages')      return _insertBlock(view, '[subpages]', 10);
}

// Arrow-key scrolling for the preview pane when the editor is not active
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  for (const entry of _editors.values()) {
    if (entry.editorWrap.style.display !== 'none') continue;       // editor active — CM handles it
    if (entry.preview.style.display === 'none') continue;          // preview hidden
    const backdrop = entry.preview.closest('.modal-backdrop');
    if (!backdrop || backdrop.style.display === 'none') continue;  // modal not open
    e.preventDefault();
    entry.preview.scrollBy({ top: e.key === 'ArrowDown' ? 60 : -60, behavior: 'smooth' });
  }
});

// Expose on window so non-module scripts (cards.js, notes.js) can call these
window.createMarkdownEditor = createMarkdownEditor;
window.getEditorValue       = getEditorValue;
window.setEditorValue       = setEditorValue;
window.insertAtCursor       = insertAtCursor;
window.focusEditor          = focusEditor;
window.applyEditorFormat    = applyEditorFormat;

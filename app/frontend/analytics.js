(function () {
  let selColumns = new Set();
  let _doneWeeks  = null;
  let _weekOffset = 0;
  let _movedWeeks   = null;
  let _movedWeekOffset = 0;
  let _movedColumns = [];

  // ---- Analysis definitions ----
  const ANALYSES = [
    {
      id: 'word-freq',
      label: 'Most used words in card title',
      params: [
        { id: 'minLength', label: 'Min word length', type: 'number', default: 5, min: 1, max: 20 },
        { id: 'topN',      label: 'Show top N',      type: 'number', default: 20, min: 1, max: 500 },
      ],
      run(cards, params) {
        const counts  = {};
        const minLen  = Math.max(1, +params.minLength || 5);
        cards.forEach(card => {
          const words = (card.text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\u00c0-\u024f\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= minLen);
          words.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
        });
        return Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, Math.max(1, +params.topN || 20))
          .map(([label, count]) => ({ label, count }));
      },
      renderResult: (results, el) => renderBarList(results, el),
    },
    {
      id: 'split-position',
      label: 'Most common value at split position',
      params: [
        { id: 'delimiter', label: 'Delimiter',          type: 'text',   default: '|' },
        { id: 'position',  label: 'Position (0-based)', type: 'number', default: 1, min: 0, max: 20 },
        { id: 'topN',      label: 'Show top N',         type: 'number', default: 20, min: 1, max: 500 },
      ],
      run(cards, params) {
        const counts = {};
        const delim  = params.delimiter || '|';
        const pos    = Math.max(0, +params.position || 0);
        cards.forEach(card => {
          const parts = (card.text || '').split(delim);
          if (parts.length > pos) {
            const val = parts[pos].trim();
            if (val) counts[val] = (counts[val] || 0) + 1;
          }
        });
        return Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, Math.max(1, +params.topN || 20))
          .map(([label, count]) => ({ label, count }));
      },
      renderResult: (results, el) => renderBarList(results, el),
    },
    {
      id: 'done-per-month',
      label: 'Done per month/week',
      params: [],
      run(cards) {
        const monthMap = {};
        const weekMap  = {};
        function monday(dateStr) {
          const d = new Date(dateStr);
          const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
          d.setDate(d.getDate() + diff);
          return d.toISOString().slice(0, 10);
        }
        cards.forEach(c => {
          if (!c.doneAt) return;
          const month = c.doneAt.slice(0, 7);
          monthMap[month] = (monthMap[month] || 0) + 1;
          const mon = monday(c.doneAt);
          weekMap[mon] = (weekMap[mon] || 0) + 1;
        });
        const months = Object.entries(monthMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, count]) => ({ label, count }));
        const weeks = Object.entries(weekMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mon, count]) => ({ mon, count }));
        return { months, weeks };
      },
      renderResult: (data, el) => renderMonthChart(data, el),
    },
    {
      id: 'moved-to-column',
      label: 'Moved to column per month/week',
      params: [],
      run(cards) {
        function monday(dateStr) {
          const d = new Date(dateStr);
          const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
          d.setDate(d.getDate() + diff);
          return d.toISOString().slice(0, 10);
        }
        const monthMap = {}, weekMap = {};
        const colSet = new Set();
        cards.forEach(c => {
          (c.moves || []).forEach(m => {
            if (!m.at || !m.to) return;
            const month = m.at.slice(0, 7);
            const mon = monday(m.at);
            colSet.add(m.to);
            if (!monthMap[month]) monthMap[month] = {};
            monthMap[month][m.to] = (monthMap[month][m.to] || 0) + 1;
            if (!weekMap[mon]) weekMap[mon] = {};
            weekMap[mon][m.to] = (weekMap[mon][m.to] || 0) + 1;
          });
        });
        const currentColTitles = new Set(state.columns.map(c => c.title));
        const columns = [...colSet].filter(col => currentColTitles.has(col)).sort();
        const months = Object.entries(monthMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, counts]) => ({ label, counts }));
        const weeks = Object.entries(weekMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mon, counts]) => ({ mon, counts }));
        return { months, weeks, columns };
      },
      renderResult: (data, el) => renderMovedChart(data, el),
    },
    {
      id: 'date-duration',
      label: 'Duration overview',
      params: [],
      run(cards) {
        const today = new Date(new Date().toISOString().slice(0, 10));
        const both      = [];
        const startOnly = [];
        const endOnly   = [];

        cards.forEach(c => {
          if (c.startDate) {
            const start = new Date(c.startDate);
            if (c.endDate) {
              const days = Math.round((new Date(c.endDate) - start) / 86400000);
              if (days >= 0) both.push(days);
            } else {
              const days = Math.round((today - start) / 86400000);
              if (days >= 0) startOnly.push(days);
            }
          } else if (c.endDate && c.created) {
            const days = Math.round((new Date(c.endDate) - new Date(c.created)) / 86400000);
            if (days >= 0) endOnly.push(days);
          }
        });

        return { both, startOnly, endOnly };
      },
      renderResult: (results, el) => renderDurationStats(results, el),
    },
  ];

  // ---- Helpers ----
  function getAnalysis() {
    const id = document.getElementById('analyticsType').value;
    return ANALYSES.find(a => a.id === id) || ANALYSES[0];
  }

  function getParams() {
    const params = {};
    getAnalysis().params.forEach(p => {
      const input = document.getElementById('analyticParam_' + p.id);
      params[p.id] = input ? input.value : p.default;
    });
    return params;
  }

  function getFilteredCards() {
    const cards = [];
    state.columns.forEach(col => {
      if (selColumns.size > 0 && !selColumns.has(col.id)) return;
      col.cards.forEach(card => cards.push(card));
    });
    return cards;
  }

  // ---- Column filter (same pattern as search.js) ----
  function buildColumnItems() {
    const items = [];
    let inboxPushed = false;
    state.columns.forEach(col => {
      if (/^inbox/i.test(col.title)) {
        if (!inboxPushed) { inboxPushed = true; items.push({ label: 'Inbox', ids: [] }); }
        items[items.length - 1].ids.push(col.id);
      } else {
        items.push({ label: col.title, ids: [col.id] });
      }
    });
    return items;
  }

  function renderColumnFilter() {
    const list   = document.getElementById('analyticsColumnList');
    const items  = buildColumnItems();
    const allIds = state.columns.map(c => c.id);

    list.innerHTML = items.map((item, i) => {
      const checked = selColumns.size === 0 || item.ids.every(id => selColumns.has(id));
      return `<label class="search-col-label">
        <input type="checkbox" class="analytics-col-cb" data-idx="${i}"${checked ? ' checked' : ''}>
        <span>${escHtml(item.label)}</span>
      </label>`;
    }).join('');

    list.querySelectorAll('.analytics-col-cb').forEach((cb, i) => {
      cb.addEventListener('change', () => {
        if (selColumns.size === 0) allIds.forEach(id => selColumns.add(id));
        if (cb.checked) items[i].ids.forEach(id => selColumns.add(id));
        else            items[i].ids.forEach(id => selColumns.delete(id));
        if (allIds.every(id => selColumns.has(id))) selColumns.clear();
      });
    });
  }

  function renderParamFields() {
    const analysis  = getAnalysis();
    const container = document.getElementById('analyticsParams');
    if (!analysis.params.length) { container.innerHTML = ''; return; }
    container.innerHTML = analysis.params.map(p => `
      <div class="analytics-param-group">
        <label class="analytics-param-label">${escHtml(p.label)}</label>
        <input id="analyticParam_${escHtml(p.id)}"
               class="analytics-param-input"
               type="${p.type}"
               value="${escHtml(String(p.default))}"
               ${p.min !== undefined ? `min="${p.min}"` : ''}
               ${p.max !== undefined ? `max="${p.max}"` : ''}
               ${p.type === 'text' ? 'spellcheck="false"' : ''}>
      </div>`).join('');
  }

  // ---- Result renderers ----
  function renderBarList(results, el) {
    if (!results.length) {
      el.innerHTML = '<p class="search-empty">No data found.</p>';
      return;
    }
    const max = results[0].count;
    el.innerHTML = results.map((r, i) => {
      const pct = max > 0 ? Math.round((r.count / max) * 100) : 0;
      return `<div class="analytics-bar-row">
        <span class="analytics-rank">${i + 1}</span>
        <span class="analytics-bar-label" title="${escHtml(r.label)}">${escHtml(r.label)}</span>
        <span class="analytics-bar-track"><span class="analytics-bar-fill" style="width:${pct}%"></span></span>
        <span class="analytics-bar-count">${r.count}</span>
      </div>`;
    }).join('');
  }

  function statGrid(durations) {
    const sorted = [...durations].sort((a, b) => a - b);
    const avg    = (sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(1);
    const mid    = sorted.length / 2;
    const median = sorted.length % 2 === 0
      ? ((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1)
      : String(sorted[Math.floor(mid)]);
    const d = v => `${v}d`;
    return `<div class="analytics-stat-grid">
      <div class="analytics-stat-item">
        <span class="analytics-stat-value">${sorted.length}</span>
        <span class="analytics-stat-label">cards</span>
      </div>
      <div class="analytics-stat-item">
        <span class="analytics-stat-value">${d(sorted[0])}</span>
        <span class="analytics-stat-label">minimum</span>
      </div>
      <div class="analytics-stat-item">
        <span class="analytics-stat-value">${d(sorted[sorted.length - 1])}</span>
        <span class="analytics-stat-label">maximum</span>
      </div>
      <div class="analytics-stat-item">
        <span class="analytics-stat-value">${d(avg)}</span>
        <span class="analytics-stat-label">average</span>
      </div>
      <div class="analytics-stat-item">
        <span class="analytics-stat-value">${d(median)}</span>
        <span class="analytics-stat-label">median</span>
      </div>
    </div>`;
  }

  function histogramSvg(durations) {
    const sorted = [...durations].sort((a, b) => a - b);
    const min = sorted[0], max = sorted[sorted.length - 1];

    // Pick a bucket size that gives 3–12 bars
    const targetBuckets = Math.min(12, Math.max(3, Math.ceil(Math.sqrt(durations.length))));
    const rawSize = max > min ? (max - min) / targetBuckets : 1;
    const niceSteps = [1, 2, 3, 5, 7, 10, 14, 21, 30, 60, 90, 180, 365];
    const bucketSize = niceSteps.find(s => s >= rawSize) || 365;

    const bucketStart = Math.floor(min / bucketSize) * bucketSize;
    const numBuckets  = Math.ceil((max - bucketStart + 1) / bucketSize);
    const buckets = Array.from({ length: numBuckets }, (_, i) => ({
      start: bucketStart + i * bucketSize,
      end:   bucketStart + (i + 1) * bucketSize - 1,
      count: 0,
    }));
    durations.forEach(d => {
      const idx = Math.floor((d - bucketStart) / bucketSize);
      if (buckets[idx]) buckets[idx].count++;
    });

    const W = 500, H = 140;
    const ml = 30, mr = 8, mt = 8, mb = 24;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const maxCount = Math.max(...buckets.map(b => b.count));
    const bw  = plotW / buckets.length;
    const gap = Math.max(1, bw * 0.12);

    // Bars
    const bars = buckets.map((b, i) => {
      if (!b.count) return '';
      const bh    = (b.count / maxCount) * plotH;
      const x     = (ml + i * bw + gap / 2).toFixed(1);
      const y     = (mt + plotH - bh).toFixed(1);
      const w     = Math.max(1, bw - gap).toFixed(1);
      const range = b.start === b.end ? `${b.start}d` : `${b.start}–${b.end}d`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${bh.toFixed(1)}" style="fill:var(--accent)" opacity="0.8" rx="2"><title>${range}: ${b.count} card${b.count !== 1 ? 's' : ''}</title></rect>`;
    }).join('');

    // Y-axis gridlines + labels
    const nTicks = Math.min(4, maxCount);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    // X-axis labels — at most 8, always include the first
    const step = Math.max(1, Math.ceil(buckets.length / 8));
    const xIndices = new Set();
    for (let i = 0; i < buckets.length; i += step) xIndices.add(i);
    xIndices.add(buckets.length - 1);
    const xLabels = [...xIndices].map(i => {
      const x = (ml + i * bw + bw / 2).toFixed(1);
      return `<text x="${x}" y="${H - 3}" text-anchor="middle">${buckets[i].start}d</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="analytics-histogram"
               style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;margin-top:10px;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${xLabels}
    </svg>`;
  }

  function renderMonthChart({ months, weeks }, el) {
    if (!months.length) {
      el.innerHTML = '<p class="search-empty">No done cards found.</p>';
      return;
    }
    _doneWeeks  = weeks;
    _weekOffset = 0;

    const W = 500, H = 180;
    const ml = 30, mr = 8, mt = 8, mb = 44;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const maxCount = Math.max(...months.map(r => r.count));
    const bw  = plotW / months.length;
    const gap = Math.max(1, bw * 0.15);

    const bars = months.map((r, i) => {
      const bh = (r.count / maxCount) * plotH;
      const x  = (ml + i * bw + gap / 2).toFixed(1);
      const y  = (mt + plotH - bh).toFixed(1);
      const w  = Math.max(1, bw - gap).toFixed(1);
      return `<rect x="${x}" y="${y}" width="${w}" height="${bh.toFixed(1)}" style="fill:var(--accent)" opacity="0.8" rx="2"><title>${escHtml(r.label)}: ${r.count} card${r.count !== 1 ? 's' : ''}</title></rect>`;
    }).join('');

    const countLabels = months.map((r, i) => {
      const bh = (r.count / maxCount) * plotH;
      if (bh < 14) return '';
      const x = (ml + i * bw + bw / 2).toFixed(1);
      const y = (mt + plotH - bh + 10).toFixed(1);
      return `<text x="${x}" y="${y}" text-anchor="middle" style="fill:var(--bg)">${r.count}</text>`;
    }).join('');

    const nTicks = Math.min(4, maxCount);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    const step = Math.max(1, Math.ceil(months.length / 12));
    const xLabels = months.map((r, i) => {
      if (i % step !== 0 && i !== months.length - 1) return '';
      const cx  = (ml + i * bw + bw / 2).toFixed(1);
      const cy  = H - mb + 12;
      const [yr, mo] = r.label.split('-');
      const lbl = `${MONTHS[parseInt(mo, 10) - 1]} ${yr.slice(2)}`;
      return `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-40,${cx},${cy})">${lbl}</text>`;
    }).join('');

    const navHtml = weeks.length > PAGE_SIZE ? `
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <button id="analyticsWeekPrev" class="btn">◀ 4w</button>
        <span id="analyticsWeekRange" style="font-size:0.72rem;color:var(--text-muted);flex:1;text-align:center"></span>
        <button id="analyticsWeekNext" class="btn">4w ▶</button>
      </div>` : '';

    el.innerHTML = `<p class="analytics-section-label">Done per month</p>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="analytics-histogram"
               style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;margin-top:10px;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${countLabels}
      ${xLabels}
    </svg>
    <p class="analytics-section-label" style="margin-top:18px">Done per week</p>
    ${navHtml}
    <div id="analyticsWeekChartInner"></div>`;

    if (weeks.length > PAGE_SIZE) {
      document.getElementById('analyticsWeekPrev').addEventListener('click', () => {
        _weekOffset = Math.max(0, _weekOffset - 4);
        renderWeekChart();
      });
      document.getElementById('analyticsWeekNext').addEventListener('click', () => {
        _weekOffset = Math.min(weeks.length - PAGE_SIZE, _weekOffset + 4);
        renderWeekChart();
      });
    }
    renderWeekChart();
  }

  const PAGE_SIZE    = 12;
  const MONTHS       = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const CHART_COLORS = ['#60a5fa','#34d399','#f97316','#a78bfa','#f43f5e','#facc15','#06b6d4','#ec4899','#84cc16','#fb923c'];

  function cwLabel(mon) {
    const d = new Date(mon);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `CW ${week}`;
  }

  function renderWeekChart() {
    const el = document.getElementById('analyticsWeekChartInner');
    if (!el || !_doneWeeks) return;

    if (!_doneWeeks.length) {
      el.innerHTML = '<p class="search-empty" style="margin:6px 0">No weekly data.</p>';
      return;
    }

    const visible  = _doneWeeks.slice(_weekOffset, _weekOffset + PAGE_SIZE);
    const maxCount = Math.max(1, ...visible.map(w => w.count));

    const W = 500, H = 150;
    const ml = 28, mr = 8, mt = 8, mb = 32;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const groupW = plotW / visible.length;
    const barW   = Math.max(2, groupW * 0.7);

    const nTicks = Math.min(maxCount, 4);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    const bars = visible.map((w, i) => {
      const bh  = (w.count / maxCount) * plotH;
      const x   = (ml + i * groupW + (groupW - barW) / 2).toFixed(1);
      const y   = (mt + plotH - bh).toFixed(1);
      const cw  = cwLabel(w.mon);
      return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" style="fill:var(--accent)" opacity="0.85" rx="1.5"><title>${cw}: ${w.count}</title></rect>`;
    }).join('');

    const step = Math.max(1, Math.ceil(visible.length / 8));
    const xLabels = visible.map((w, i) => {
      if (i % step !== 0) return '';
      const cx = (ml + i * groupW + groupW / 2).toFixed(1);
      const cy = H - mb + 12;
      return `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-35,${cx},${cy})">${cwLabel(w.mon)}</text>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
        style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${xLabels}
    </svg>`;

    const prevBtn = document.getElementById('analyticsWeekPrev');
    const nextBtn = document.getElementById('analyticsWeekNext');
    const rangeEl = document.getElementById('analyticsWeekRange');
    if (prevBtn) prevBtn.disabled = _weekOffset <= 0;
    if (nextBtn) nextBtn.disabled = _weekOffset + PAGE_SIZE >= _doneWeeks.length;
    if (rangeEl && visible.length) {
      const fmt = s => { const d = new Date(s); return `${cwLabel(s)} ${d.getFullYear()}`; };
      rangeEl.textContent = `${fmt(visible[0].mon)} – ${fmt(visible[visible.length - 1].mon)}`;
    }
  }

  function renderMovedChart({ months, weeks, columns }, el) {
    if (!months.length) {
      el.innerHTML = '<p class="search-empty">No move history found.</p>';
      return;
    }
    _movedWeeks      = weeks;
    _movedWeekOffset = 0;
    _movedColumns    = columns;

    const W = 500, H = 180;
    const ml = 30, mr = 8, mt = 8, mb = 44;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const nc = columns.length;
    const maxCount = Math.max(1, ...months.flatMap(r => columns.map(col => r.counts[col] || 0)));
    const groupW = plotW / months.length;
    const barGap = 1;
    const barW   = Math.max(1, (groupW * 0.85) / Math.max(1, nc));

    const bars = months.map((r, i) => {
      const gx = ml + i * groupW + groupW * 0.075;
      return columns.map((col, ci) => {
        const count = r.counts[col] || 0;
        if (!count) return '';
        const bh    = (count / maxCount) * plotH;
        const x     = (gx + ci * (barW + barGap)).toFixed(1);
        const y     = (mt + plotH - bh).toFixed(1);
        const color = CHART_COLORS[ci % CHART_COLORS.length];
        return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.85" rx="1.5"><title>${escHtml(r.label)} · ${escHtml(col)}: ${count}</title></rect>`;
      }).join('');
    }).join('');

    const nTicks = Math.min(4, maxCount);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    const step = Math.max(1, Math.ceil(months.length / 12));
    const xLabels = months.map((r, i) => {
      if (i % step !== 0 && i !== months.length - 1) return '';
      const cx = (ml + i * groupW + groupW / 2).toFixed(1);
      const cy = H - mb + 12;
      const [yr, mo] = r.label.split('-');
      return `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-40,${cx},${cy})">${MONTHS[parseInt(mo, 10) - 1]} ${yr.slice(2)}</text>`;
    }).join('');

    const legendHtml = `<div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:0.7rem;color:var(--text-muted);margin-top:8px">
      ${columns.map((col, ci) => `<span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:8px;background:${CHART_COLORS[ci % CHART_COLORS.length]};border-radius:2px"></span>${escHtml(col)}</span>`).join('')}
    </div>`;

    const navHtml = weeks.length > PAGE_SIZE ? `
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <button id="analyticsMovedWeekPrev" class="btn">◀ 4w</button>
        <span id="analyticsMovedWeekRange" style="font-size:0.72rem;color:var(--text-muted);flex:1;text-align:center"></span>
        <button id="analyticsMovedWeekNext" class="btn">4w ▶</button>
      </div>` : '';

    el.innerHTML = `<p class="analytics-section-label">Moved to column per month</p>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="analytics-histogram"
               style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;margin-top:10px;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${xLabels}
    </svg>
    ${legendHtml}
    <p class="analytics-section-label" style="margin-top:18px">Moved to column per week</p>
    ${navHtml}
    <div id="analyticsMovedWeekChartInner"></div>`;

    if (weeks.length > PAGE_SIZE) {
      document.getElementById('analyticsMovedWeekPrev').addEventListener('click', () => {
        _movedWeekOffset = Math.max(0, _movedWeekOffset - 4);
        renderMovedWeekChart();
      });
      document.getElementById('analyticsMovedWeekNext').addEventListener('click', () => {
        _movedWeekOffset = Math.min(_movedWeeks.length - PAGE_SIZE, _movedWeekOffset + 4);
        renderMovedWeekChart();
      });
    }
    renderMovedWeekChart();
  }

  function renderMovedWeekChart() {
    const el = document.getElementById('analyticsMovedWeekChartInner');
    if (!el || !_movedWeeks) return;

    if (!_movedWeeks.length) {
      el.innerHTML = '<p class="search-empty" style="margin:6px 0">No weekly data.</p>';
      return;
    }

    const visible = _movedWeeks.slice(_movedWeekOffset, _movedWeekOffset + PAGE_SIZE);
    const columns = _movedColumns;
    const nc      = columns.length;
    const maxCount = Math.max(1, ...visible.flatMap(w => columns.map(col => w.counts[col] || 0)));

    const W = 500, H = 150;
    const ml = 28, mr = 8, mt = 8, mb = 32;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const groupW = plotW / visible.length;
    const barGap = 1;
    const barW   = Math.max(1, (groupW * 0.85) / Math.max(1, nc));

    const nTicks = Math.min(maxCount, 4);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    const bars = visible.map((w, i) => {
      const gx = ml + i * groupW + groupW * 0.075;
      const cw = cwLabel(w.mon);
      return columns.map((col, ci) => {
        const count = w.counts[col] || 0;
        if (!count) return '';
        const bh    = (count / maxCount) * plotH;
        const x     = (gx + ci * (barW + barGap)).toFixed(1);
        const y     = (mt + plotH - bh).toFixed(1);
        const color = CHART_COLORS[ci % CHART_COLORS.length];
        return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.85" rx="1.5"><title>${cw} · ${escHtml(col)}: ${count}</title></rect>`;
      }).join('');
    }).join('');

    const step = Math.max(1, Math.ceil(visible.length / 8));
    const xLabels = visible.map((w, i) => {
      if (i % step !== 0) return '';
      const cx = (ml + i * groupW + groupW / 2).toFixed(1);
      const cy = H - mb + 12;
      return `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-35,${cx},${cy})">${cwLabel(w.mon)}</text>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
        style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${xLabels}
    </svg>`;

    const prevBtn = document.getElementById('analyticsMovedWeekPrev');
    const nextBtn = document.getElementById('analyticsMovedWeekNext');
    const rangeEl = document.getElementById('analyticsMovedWeekRange');
    if (prevBtn) prevBtn.disabled = _movedWeekOffset <= 0;
    if (nextBtn) nextBtn.disabled = _movedWeekOffset + PAGE_SIZE >= _movedWeeks.length;
    if (rangeEl && visible.length) {
      const fmt = s => `${cwLabel(s)} ${new Date(s).getFullYear()}`;
      rangeEl.textContent = `${fmt(visible[0].mon)} – ${fmt(visible[visible.length - 1].mon)}`;
    }
  }

  const DURATION_CASES = [
    { key: 'both',      color: '#60a5fa', label: 'Start + end' },
    { key: 'startOnly', color: '#34d399', label: 'Start only'  },
    { key: 'endOnly',   color: '#fb923c', label: 'End only'    },
  ];

  function durationHistogramHtml({ both, startOnly, endOnly }) {
    const activeCases = DURATION_CASES.filter(c => ({ both, startOnly, endOnly })[c.key].length > 0)
      .map(c => ({ ...c, data: ({ both, startOnly, endOnly })[c.key] }));
    if (!activeCases.length) return '';

    const allDurations = activeCases.flatMap(c => c.data);
    const gMin = Math.min(...allDurations);
    const gMax = Math.max(...allDurations);

    const targetBuckets = Math.min(12, Math.max(3, Math.ceil(Math.sqrt(allDurations.length))));
    const rawSize  = gMax > gMin ? (gMax - gMin) / targetBuckets : 1;
    const niceSteps = [1,2,3,5,7,10,14,21,30,60,90,180,365];
    const bucketSize  = niceSteps.find(s => s >= rawSize) || 365;
    const bucketStart = Math.floor(gMin / bucketSize) * bucketSize;
    const numBuckets  = Math.ceil((gMax - bucketStart + 1) / bucketSize);

    const buckets = Array.from({ length: numBuckets }, (_, i) => {
      const start = bucketStart + i * bucketSize;
      const counts = {};
      activeCases.forEach(c => { counts[c.key] = 0; });
      return { start, end: start + bucketSize - 1, counts };
    });
    activeCases.forEach(c => {
      c.data.forEach(d => {
        const idx = Math.floor((d - bucketStart) / bucketSize);
        if (buckets[idx]) buckets[idx].counts[c.key]++;
      });
    });

    const nc       = activeCases.length;
    const maxCount = Math.max(1, ...buckets.flatMap(b => activeCases.map(c => b.counts[c.key])));

    const W = 500, H = 150;
    const ml = 28, mr = 8, mt = 8, mb = 24;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const groupW = plotW / buckets.length;
    const barGap = 1.5;
    const barW   = Math.max(2, (groupW - barGap * (nc + 1)) / nc);

    const nTicks = Math.min(maxCount, 4);
    const yLines = Array.from({ length: nTicks + 1 }, (_, i) => {
      const v  = Math.round((maxCount / nTicks) * i);
      const y  = (mt + plotH - (v / maxCount) * plotH).toFixed(1);
      const da = i === 0 ? '' : ' stroke-dasharray="3,3"';
      return `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" style="stroke:var(--border)" stroke-width="0.5"${da}/>
              <text x="${ml - 4}" y="${y}" text-anchor="end" dominant-baseline="middle">${v}</text>`;
    }).join('');

    const bars = buckets.map((b, gi) => {
      const gx    = ml + gi * groupW + barGap;
      const range = b.start === b.end ? `${b.start}d` : `${b.start}–${b.end}d`;
      return activeCases.map((c, ci) => {
        const count = b.counts[c.key];
        if (!count) return '';
        const bh = (count / maxCount) * plotH;
        const x  = (gx + ci * (barW + barGap)).toFixed(1);
        const y  = (mt + plotH - bh).toFixed(1);
        return `<rect x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${c.color}" opacity="0.85" rx="1.5"><title>${range}: ${count} · ${c.label}</title></rect>`;
      }).join('');
    }).join('');

    const step = Math.max(1, Math.ceil(buckets.length / 8));
    const xLabels = buckets.map((b, i) => {
      if (i % step !== 0 && i !== buckets.length - 1) return '';
      const x = (ml + i * groupW + groupW / 2).toFixed(1);
      return `<text x="${x}" y="${H - 3}" text-anchor="middle">${b.start}d</text>`;
    }).join('');

    const legendHtml = `<div style="display:flex;gap:14px;font-size:0.7rem;color:var(--text-muted);margin-bottom:4px">
      ${activeCases.map(c => `<span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:8px;background:${c.color};border-radius:2px"></span>${c.label}</span>`).join('')}
    </div>`;

    return legendHtml + `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
        style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;max-width:100%">
      ${yLines}
      <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + plotH}" style="stroke:var(--border)" stroke-width="1"/>
      ${bars}
      ${xLabels}
    </svg>`;
  }

  function renderDurationStats({ both, startOnly, endOnly }, el) {
    const cases = [];
    if (both.length)      cases.push({ label: 'Start + end',  data: both });
    if (startOnly.length) cases.push({ label: 'Start only',   data: startOnly });
    if (endOnly.length)   cases.push({ label: 'End only',     data: endOnly });

    if (!cases.length) {
      el.innerHTML = '<p class="search-empty">No cards with date information found.</p>';
      return;
    }

    const stats = cases.map(({ label, data }) => {
      const sorted = [...data].sort((a, b) => a - b);
      const n      = sorted.length;
      const min    = sorted[0];
      const max    = sorted[n - 1];
      const avg    = sorted.reduce((s, v) => s + v, 0) / n;
      const mid    = n / 2;
      const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
      return { label, n, min, max, avg, median };
    });

    const globalMax = Math.max(...stats.map(s => s.max));
    const niceSteps = [1,2,5,7,10,14,21,30,60,90,180,365,730];
    const rawStep   = globalMax / 5;
    const tickStep  = niceSteps.find(s => s >= rawStep) || Math.ceil(rawStep / 365) * 365;
    const axisMax   = Math.ceil(globalMax / tickStep) * tickStep;
    const ticks     = [];
    for (let v = 0; v <= axisMax; v += tickStep) ticks.push(v);

    const W = 500, rowH = 52;
    const ml = 88, mr = 8, mt = 24, mb = 20;
    const H      = mt + cases.length * rowH + mb;
    const plotW  = W - ml - mr;
    const xScale = v => ml + (v / axisMax) * plotW;

    const gridLines = ticks.map(v => {
      const x = xScale(v).toFixed(1);
      return `<line x1="${x}" y1="${mt}" x2="${x}" y2="${mt + cases.length * rowH}" style="stroke:var(--border)" stroke-width="0.5"${v > 0 ? ' stroke-dasharray="3,3"' : ''}/>
              <text x="${x}" y="${H - 4}" text-anchor="middle">${v}d</text>`;
    }).join('');

    const barH = 16;
    const rows = stats.map(({ label, n, min, max, avg, median }, i) => {
      const midY = mt + i * rowH + rowH / 2;
      const barY = midY - barH / 2;
      const xMin = xScale(min);
      const xMax = xScale(max);
      const xAvg = xScale(avg);
      const xMed = xScale(median);
      const barW = Math.max(2, xMax - xMin);

      return `<text x="${ml - 8}" y="${midY - 4}" text-anchor="end" dominant-baseline="middle" style="fill:var(--text)">${escHtml(label)}</text>
              <text x="${ml - 8}" y="${midY + 9}" text-anchor="end" style="fill:var(--text-muted)">n=${n}</text>
              <rect x="${xMin.toFixed(1)}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" style="fill:var(--accent)" opacity="0.22" rx="3"><title>min: ${min}d / max: ${max}d</title></rect>
              <line x1="${xMed.toFixed(1)}" y1="${barY.toFixed(1)}" x2="${xMed.toFixed(1)}" y2="${(barY + barH).toFixed(1)}" style="stroke:var(--accent)" stroke-width="2.5"><title>median: ${median.toFixed(1)}d</title></line>
              <line x1="${xAvg.toFixed(1)}" y1="${(barY - 4).toFixed(1)}" x2="${xAvg.toFixed(1)}" y2="${(barY + barH + 4).toFixed(1)}" style="stroke:var(--text-muted)" stroke-width="1.5" stroke-dasharray="3,2"><title>avg: ${avg.toFixed(1)}d</title></line>`;
    }).join('');

    const lx = ml, ly = 12;
    const legend = `
      <rect x="${lx}" y="${ly - 5}" width="20" height="10" style="fill:var(--accent)" opacity="0.22" rx="2"/>
      <text x="${lx + 24}" y="${ly}" dominant-baseline="middle">range</text>
      <line x1="${lx + 62}" y1="${ly - 6}" x2="${lx + 62}" y2="${ly + 6}" style="stroke:var(--accent)" stroke-width="2.5"/>
      <text x="${lx + 66}" y="${ly}" dominant-baseline="middle">median</text>
      <line x1="${lx + 114}" y1="${ly - 6}" x2="${lx + 114}" y2="${ly + 6}" style="stroke:var(--text-muted)" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="${lx + 118}" y="${ly}" dominant-baseline="middle">avg</text>`;

    el.innerHTML = `<p class="analytics-section-label">Duration overview</p>
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
        style="font-size:9px;font-family:'DM Mono',monospace;fill:var(--text-muted);display:block;margin-top:6px;max-width:100%">
      ${gridLines}
      ${rows}
      ${legend}
    </svg>
    <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
    ${durationHistogramHtml({ both, startOnly, endOnly })}`;
  }

  // ---- Run ----
  function runAnalysis() {
    const analysis = getAnalysis();
    const cards    = getFilteredCards();
    const results  = analysis.run(cards, getParams());
    const el       = document.getElementById('analyticsResults');
    analysis.renderResult(results, el);
    const n = cards.length;
    document.getElementById('analyticsCardCount').textContent =
      `${n} card${n !== 1 ? 's' : ''} analyzed`;
  }

  // ---- Open / close ----
  window.openAnalytics = function () {
    if (!API) return;
    selColumns.clear();

    const sel = document.getElementById('analyticsType');
    sel.innerHTML = ANALYSES.map(a =>
      `<option value="${escHtml(a.id)}">${escHtml(a.label)}</option>`
    ).join('');

    renderColumnFilter();
    renderParamFields();
    document.getElementById('analyticsResults').innerHTML = '';
    document.getElementById('analyticsCardCount').textContent = '';
    document.getElementById('analyticsBackdrop').style.display = 'flex';
  };

  window.closeAnalytics = function () {
    document.getElementById('analyticsBackdrop').style.display = 'none';
  };

  // ---- Event wiring ----
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('analyticsType').addEventListener('change', () => {
      renderParamFields();
      document.getElementById('analyticsResults').innerHTML = '';
      document.getElementById('analyticsCardCount').textContent = '';
    });
    document.getElementById('analyticsRunBtn').addEventListener('click', runAnalysis);
    document.getElementById('analyticsBackdrop').addEventListener('click', e => {
      if (e.target === document.getElementById('analyticsBackdrop')) closeAnalytics();
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('analyticsBackdrop').style.display !== 'none')
      closeAnalytics();
  });
})();

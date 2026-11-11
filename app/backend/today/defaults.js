'use strict';
// Default "Today" page config (/today). Layouts are per breakpoint; a breakpoint without a
// layout is derived from the next larger one in the frontend (today.js#_todayResolveLayout).

const TILE_SIZES   = ['1/1', '2/3', '1/2', '1/3', 'container', 'available'];
const BREAKPOINTS  = ['xl', 'lg', 'md', 'sm'];

const DEFAULT_LAYOUTS = {
  xl: {
    columns: [{ width: 2 }, { width: 1 }, { width: 1 }],
    tiles: [
      { id: 'agenda',    col: 0, order: 0, size: '1/1' },
      { id: 'search',    col: 1, order: 0, size: 'container' },
      { id: 'attention', col: 1, order: 1, size: 'container' },
      { id: 'weather',   col: 1, order: 2, size: 'container' },
      { id: 'notes',     col: 1, order: 3, size: 'available' },
      { id: 'quickaccess', col: 2, order: 0, size: 'container' },
      { id: 'cvapp',     col: 2, order: 1, size: '1/2' },
      { id: 'progress',  col: 2, order: 2, size: 'container' },
      { id: 'boards',    col: 2, order: 3, size: 'container' },
    ],
  },
  lg: {
    columns: [{ width: 2 }, { width: 1 }],
    tiles: [
      { id: 'agenda',    col: 0, order: 0, size: '1/1' },
      { id: 'search',    col: 1, order: 0, size: 'container' },
      { id: 'quickaccess', col: 1, order: 1, size: 'container' },
      { id: 'attention', col: 1, order: 2, size: 'container' },
      { id: 'weather',   col: 1, order: 3, size: 'container' },
      { id: 'cvapp',     col: 1, order: 4, size: '1/3' },
      { id: 'progress',  col: 1, order: 5, size: 'container' },
      { id: 'boards',    col: 1, order: 6, size: 'container' },
      { id: 'notes',     col: 1, order: 7, size: 'available' },
    ],
  },
  sm: {
    columns: [{ width: 1 }],
    tiles: [
      { id: 'attention', col: 0, order: 0, size: 'container' },
      { id: 'search',    col: 0, order: 1, size: 'container' },
      { id: 'quickaccess', col: 0, order: 2, size: 'container' },
      { id: 'agenda',    col: 0, order: 3, size: 'container' },
      { id: 'weather',   col: 0, order: 4, size: 'container' },
      { id: 'cvapp',     col: 0, order: 5, size: 'container' },
      { id: 'progress',  col: 0, order: 6, size: 'container' },
      { id: 'boards',    col: 0, order: 7, size: 'container' },
      { id: 'notes',     col: 0, order: 8, size: 'container' },
    ],
  },
};

function defaultTodayConfig() {
  return {
    showBar: true,
    refreshMinutes: 1,
    disabled: [],
    widgets: {},
    layouts: JSON.parse(JSON.stringify(DEFAULT_LAYOUTS)),
  };
}

module.exports = { TILE_SIZES, BREAKPOINTS, DEFAULT_LAYOUTS, defaultTodayConfig };

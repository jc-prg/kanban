const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

const _moveSchema = {
  type: 'object', additionalProperties: false,
  properties: { at: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, board: { type: 'string' }, toBoard: { type: 'string' } }
};
const _schedRecurrenceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    type:       { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval:   { type: 'integer', minimum: 1, maximum: 365 },
    daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7 },
    dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
    month:      { type: 'integer', minimum: 1, maximum: 12 },
  },
};
const _cardSchema = {
  type: 'object', required: ['id', 'text'], additionalProperties: false,
  properties: {
    id:          { type: 'string', minLength: 1 },
    text:        { type: 'string' },
    color:       { type: 'string' },
    priority:    { type: 'integer', minimum: 1, maximum: 5 },
    description: { type: 'string' },
    link:        { type: 'string' },
    startDate:   { type: 'string' },
    endDate:     { type: 'string' },
    done:         { type: 'boolean' },
    doneAt:       { type: 'string' },
    duplicate:    { type: 'boolean' },
    unread:       { type: 'boolean' },
    created:      { type: 'string' },
    lastModified: { type: 'string' },
    moves:        { type: 'array', items: _moveSchema },
    scheduledFor:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    scheduledTarget: { type: 'string' },
    scheduledEndDate:{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    recurrence:      _schedRecurrenceSchema,
    nextDueDate:     { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    lastCreatedDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    // Calendar event the card was created from (CalDAV UID — stable across moves/edits)
    calEvent: {
      type: 'object', required: ['accountId', 'uid'], additionalProperties: false,
      properties: {
        accountId: { type: 'string', minLength: 1, maxLength: 200 },
        uid:       { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
    // Mail the card was created from (Message-ID — stable across folder moves; folder is a search hint)
    mailRef: {
      type: 'object', required: ['accountId', 'messageId'], additionalProperties: false,
      properties: {
        accountId: { type: 'string', minLength: 1, maxLength: 200 },
        messageId: { type: 'string', minLength: 1, maxLength: 998 },
        folder:    { type: 'string', maxLength: 1000 },
        subject:   { type: 'string', maxLength: 1000 },
      },
    },
  }
};
const _columnSchema = {
  type: 'object', required: ['id', 'title', 'cards'], additionalProperties: false,
  properties: {
    id:      { type: 'string', minLength: 1 },
    title:   { type: 'string' },
    color:   { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    cards:   { type: 'array', items: _cardSchema }
  }
};
const _settingsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    description:        { type: 'string' },
    archived:           { type: 'boolean' },
    inboxWithDate:      { type: 'boolean' },
    persistCollapse:    { type: 'boolean' },
    collapsedColumnIds: { type: 'array', items: { type: 'string' } },
    trackedColumns:     { type: 'array', items: { type: 'string' } },
    notesSidebarOpen:      { type: 'boolean' },
    notesSidebarWidth:     { type: 'number' },
    notesFontSize:         { type: 'number' },
    autoSaveDialogs:       { type: 'boolean' },
    autoSaveIntervalMin:   { type: 'number' },
    hideDoneInOverview:    { type: 'boolean' },
    scheduledColumnId:     { type: 'string' },
  }
};

const validateBoard = ajv.compile({
  type: 'object', required: ['columns'], additionalProperties: false,
  properties: { columns: { type: 'array', items: _columnSchema }, settings: _settingsSchema }
});
const validateBoardPatch = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    columnOrder:      { type: 'array', items: { type: 'string' } },
    updatedColumns:   { type: 'array', items: _columnSchema },
    removedColumnIds: { type: 'array', items: { type: 'string' } },
    settings:         _settingsSchema
  }
});
// v2 notes schema: items array of folders and pages
const _noteItemSchema = {
  type: 'object', required: ['type', 'id', 'title'],
  properties: {
    type:           { type: 'string', enum: ['folder', 'page'] },
    id:             { type: 'string', minLength: 1 },
    title:          { type: 'string' },
    // folder-only
    children:       { type: 'array' },
    // page-only
    description:    { type: 'string' },
    link:           { type: 'string' },
    linkedCards:    { type: 'array', items: { type: 'string' } },
    hasAttachments:  { type: 'boolean' },
    attachmentCount: { type: 'integer', minimum: 0 },
    lastModified:    { type: 'string' },
  }
};
const validateNotes = ajv.compile({
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items:         { type: 'array', items: _noteItemSchema },
    schemaVersion: { type: 'integer' },
  }
});
const _notePagePatchSchema = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: {
    id:             { type: 'string', minLength: 1 },
    type:           { type: 'string' },
    title:          { type: 'string' },
    description:    { type: 'string' },
    link:           { type: 'string' },
    linkedCards:    { type: 'array', items: { type: 'string' } },
    hasAttachments:  { type: 'boolean' },
    attachmentCount: { type: 'integer', minimum: 0 },
    lastModified:    { type: 'string' },
    wdPath:          { type: 'string' }
  }
};
const validateNotesPatch = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    updatedPages: { type: 'array', items: _notePagePatchSchema }
  }
});

const _inboxCardSchema = {
  type: 'object', required: ['text'], additionalProperties: false,
  properties: {
    text:        { type: 'string', minLength: 1 },
    color:       { type: 'string' },
    priority:    { type: 'integer', minimum: 1, maximum: 5 },
    description: { type: 'string' },
    link:        { type: 'string' },
    startDate:   { type: 'string' },
    endDate:     { type: 'string' },
    done:        { type: 'boolean' },
    doneAt:      { type: 'string' },
    lastModified: { type: 'string' }
  }
};
const validateInboxCards = ajv.compile({
  oneOf: [
    _inboxCardSchema,
    { type: 'array', items: _inboxCardSchema }
  ]
});

const _templateSchema = {
  type: 'object', required: ['id', 'name'], additionalProperties: false,
  properties: {
    id:          { type: 'string', pattern: '^tpl-[a-z0-9]{1,12}$' },
    name:        { type: 'string', minLength: 1, maxLength: 100 },
    text:        { type: 'string', maxLength: 300 },
    color:       { type: 'string', maxLength: 20 },
    priority:    { type: 'integer', minimum: 0, maximum: 5 },
    description: { type: 'string', maxLength: 10000 },
    link:        { type: 'string', maxLength: 2000 },
  },
};
const validateTemplates = ajv.compile({
  type: 'object', required: ['items'], additionalProperties: false,
  properties: {
    items: { type: 'array', maxItems: 100, items: _templateSchema },
  },
});

const validateCalendarEvent = ajv.compile({
  type: 'object',
  required: ['title', 'allDay', 'start', 'end'],
  additionalProperties: false,
  properties: {
    title:       { type: 'string', minLength: 1, maxLength: 500 },
    allDay:      { type: 'boolean' },
    start:       { type: 'string' },
    end:         { type: 'string' },
    timezone:    { type: 'string', maxLength: 100 },
    location:    { type: 'string', maxLength: 500 },
    description: { type: 'string', maxLength: 10000 },
    etag:           { type: 'string' },
    href:           { type: 'string' },
    editScope:      { type: 'string', enum: ['occurrence', 'series'] },
    occurrenceDate: { type: 'string' },
    rrule:          { type: 'string', maxLength: 500 },
    // Hidden links to kanban cards (X-JC-KANBAN-CARD) — passed through on full rebuilds
    cardRefs: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', required: ['board', 'cardId'], additionalProperties: false,
        properties: { board: { type: 'string', maxLength: 64 }, cardId: { type: 'string', maxLength: 64 } },
      },
    },
  },
});

const _cardLinkProps = {
  board:  { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
  cardId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
};
const validateCalendarCardLink = ajv.compile({
  type: 'object', required: ['board', 'cardId'], additionalProperties: false,
  properties: { ..._cardLinkProps, href: { type: 'string', maxLength: 2000 } },
});
const validateMailCardLink = ajv.compile({
  type: 'object', required: ['board', 'cardId'], additionalProperties: false,
  properties: _cardLinkProps,
});

const _recurringTaskSchema = {
  type: 'object',
  required: ['card', 'targetColumn', 'recurrence', 'startDate'],
  additionalProperties: false,
  properties: {
    id:           { type: 'string', pattern: '^rt-[a-z0-9]{1,12}$' },
    enabled:      { type: 'boolean' },
    card: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: {
        text:        { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string', maxLength: 10000 },
        color:       { type: 'string', maxLength: 20 },
        priority:    { type: 'integer', minimum: 1, maximum: 5 },
        link:        { type: 'string', maxLength: 2000 },
      },
    },
    targetColumn:    { type: 'string', minLength: 1, maxLength: 200 },
    recurrence: {
      type: 'object', required: ['type'], additionalProperties: false,
      properties: {
        type:       { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        interval:   { type: 'integer', minimum: 1, maximum: 365 },
        daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7 },
        dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
        month:      { type: 'integer', minimum: 1, maximum: 12 },
      },
    },
    startDate:       { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    endDate:         { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    lastCreatedDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    nextDueDate:     { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
};

const validateRecurringTasks = ajv.compile({
  type: 'object', required: ['tasks'], additionalProperties: false,
  properties: {
    tasks: { type: 'array', maxItems: 50, items: _recurringTaskSchema },
  },
});

const _mailAddrList = { type: 'string', maxLength: 4000 };
const validateMailSend = ajv.compile({
  type: 'object',
  required: ['to'],
  additionalProperties: false,
  properties: {
    from:        { type: 'string', maxLength: 320 },
    to:          { ..._mailAddrList, minLength: 3 },
    cc:          _mailAddrList,
    bcc:         _mailAddrList,
    subject:     { type: 'string', maxLength: 998 },
    html:        { type: 'string', maxLength: 5_000_000 },
    text:        { type: 'string', maxLength: 5_000_000 },
    inReplyTo:   { type: 'string', maxLength: 998 },
    references:  { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 998 } },
    replyUid:    { type: 'string', pattern: '^[0-9]{1,10}$' },
    replyFolder: { type: 'string', minLength: 1, maxLength: 255 },
    forwardAccount: { type: 'string', minLength: 1, maxLength: 64 },
    forwardUid:     { type: 'string', pattern: '^[0-9]{1,10}$' },
    forwardFolder:  { type: 'string', minLength: 1, maxLength: 255 },
    forwardParts:   { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$' } },
  },
});

/** IMAP folder path: 1–255 chars, no control characters. */
function validMailFolderPath(path) {
  return typeof path === 'string' && path.length >= 1 && path.length <= 255 && !/[\x00-\x1f\x7f]/.test(path);
}

// ---- Stickies (Today widget) ----
const STICKY_CATEGORIES = ['note', 'quote', 'intervention', 'other'];
const STICKY_RHYTHMS    = [0, 10, 30, 60, 120, 240, 480, 1440];
const STICKY_ID         = /^s-[0-9a-f]{12}$/;
const _stickyProps = {
  text:     { type: 'string', minLength: 1, maxLength: 5000, pattern: '\\S' },
  source:   { type: 'string', maxLength: 500 },   // author, book, URL …; '' = none
  color:    { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  category: { type: 'string', enum: STICKY_CATEGORIES },
};
const validateStickyCreate = ajv.compile({
  type: 'object', required: ['text'], additionalProperties: false, properties: _stickyProps,
});
const validateStickyUpdate = ajv.compile({
  type: 'object', minProperties: 1, additionalProperties: false,
  // pos: sort key set by drag & drop in the Stickies grid (global-db.js stickyOrderKey)
  properties: { ..._stickyProps, pos: { type: 'number', minimum: -1e15, maximum: 1e15 } },
});

// ---- Today page config (/today) ----
// Stored Quick access icon: content-addressed name (today/quickaccess.js)
const QA_ICON_FILE = /^qa-[a-f0-9]{16}\.(png|ico|svg|jpg|webp|gif)$/;
const _todayLayoutSchema = {
  type: 'object', required: ['columns', 'tiles'], additionalProperties: false,
  properties: {
    columns: {
      type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'object', required: ['width'], additionalProperties: false,
               properties: { width: { type: 'integer', minimum: 1, maximum: 3 } } },
    },
    tiles: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', required: ['id', 'col', 'size'], additionalProperties: false,
        properties: {
          id:    { type: 'string', pattern: '^[a-z0-9-]{1,32}$' },
          col:   { type: 'integer', minimum: 0, maximum: 3 },
          order: { type: 'integer', minimum: 0, maximum: 999 },
          size:  { type: 'string', enum: ['1/1', '2/3', '1/2', '1/3', 'container', 'available'] },
        },
      },
    },
  },
};
const validateTodayConfig = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    showBar: { type: 'boolean' },
    refreshMinutes: { type: 'integer', minimum: 0, maximum: 60 },   // 0 = no automatic refresh
    disabled: { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' } },   // deactivated widgets
    widgets: {
      type: 'object',
      properties: {
        weather: {
          type: 'object', additionalProperties: false,
          properties: {
            lat:   { type: 'number', minimum: -90,  maximum: 90 },
            lon:   { type: 'number', minimum: -180, maximum: 180 },
            label: { type: 'string', maxLength: 120 },
            days:  { type: 'integer', enum: [1, 7] },   // tile: today (1) or the 7-day forecast
          },
        },
        agenda: {
          type: 'object', additionalProperties: false,
          properties: { days: { type: 'integer', enum: [2, 7] } },
        },
        stickies: {
          type: 'object', additionalProperties: false,
          properties: {
            rhythm: { type: 'integer', enum: STICKY_RHYTHMS },   // minutes between random stickies brought to the top; 0 = only on request
            filter: { type: 'string', enum: ['all', ...STICKY_CATEGORIES] },   // last selected category filter (same on all devices)
          },
        },
        cvapp: {
          type: 'object', additionalProperties: false,
          properties: {
            apiUrl:     { type: 'string', maxLength: 500 },
            publicUrl:  { type: 'string', maxLength: 500 },
            apiKey:     { type: 'string', maxLength: 500 },
            hasApiKey:  { type: 'boolean' },
          },
        },
        quickaccess: {
          type: 'object', additionalProperties: false,
          properties: {
            visible: { type: 'integer', minimum: 0, maximum: 50 },   // 0 = all
            size:    { type: 'string', enum: ['s', 'm', 'l'] },
            showTitles: { type: 'boolean' },   // default true
            items: {
              type: 'array', maxItems: 100,
              items: {
                type: 'object', required: ['id', 'url', 'icon'], additionalProperties: false,
                properties: {
                  id:    { type: 'string', pattern: '^qa-[a-z0-9]{1,24}$' },
                  url:   { type: 'string', maxLength: 2000, pattern: '^https?://\\S+$' },
                  title: { type: 'string', maxLength: 80 },
                  icon: {
                    oneOf: [
                      { type: 'object', required: ['type', 'file'], additionalProperties: false,
                        properties: { type: { const: 'image' }, file: { type: 'string', pattern: QA_ICON_FILE.source },
                                      invertDark: { type: 'boolean' } } },   // dark icon → inverted in dark mode
                      { type: 'object', required: ['type', 'value'], additionalProperties: false,
                        properties: { type: { const: 'emoji' }, value: { type: 'string', minLength: 1, maxLength: 16 } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      additionalProperties: { type: 'object' },
    },
    layouts: {
      type: 'object', additionalProperties: false,
      properties: { xl: _todayLayoutSchema, lg: _todayLayoutSchema, md: _todayLayoutSchema, sm: _todayLayoutSchema },
    },
  },
});

function schemaError(validate) {
  return validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

module.exports = { validateBoard, validateBoardPatch, validateNotes, validateNotesPatch, validateInboxCards, validateCalendarEvent, validateCalendarCardLink, validateMailCardLink, validateRecurringTasks, validateTemplates, validateMailSend, validMailFolderPath, validateTodayConfig, QA_ICON_FILE, validateStickyCreate, validateStickyUpdate, STICKY_CATEGORIES, STICKY_RHYTHMS, STICKY_ID, schemaError };

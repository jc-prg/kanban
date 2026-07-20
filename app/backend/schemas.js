const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

const _moveSchema = {
  type: 'object', additionalProperties: false,
  properties: { at: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }
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
    created:      { type: 'string' },
    lastModified: { type: 'string' },
    moves:        { type: 'array', items: _moveSchema }
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
    hideDoneInOverview:    { type: 'boolean' }
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
  },
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

function schemaError(validate) {
  return validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

module.exports = { validateBoard, validateBoardPatch, validateNotes, validateNotesPatch, validateInboxCards, validateCalendarEvent, validateRecurringTasks, schemaError };

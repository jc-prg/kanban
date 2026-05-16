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
    webdav: {
      type: 'object', additionalProperties: false,
      properties: {
        enabled:  { type: 'boolean' },
        url:      { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
      }
    }
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
const validateNotes = ajv.compile({
  type: 'object', required: ['pages'], additionalProperties: false,
  properties: {
    pages:          { type: 'array', items: { $ref: '#/definitions/page' } },
    deletedPageIds: { type: 'array', items: { type: 'string' } }
  },
  definitions: {
    page: {
      type: 'object', required: ['id', 'title'], additionalProperties: false,
      properties: {
        id:             { type: 'string', minLength: 1 },
        title:          { type: 'string' },
        description:    { type: 'string' },
        link:           { type: 'string' },
        linkedCards:    { type: 'array', items: { type: 'string' } },
        hasAttachments: { type: 'boolean' },
        attachments:    { type: 'array', items: { type: 'string' } },
        lastModified:   { type: 'string' },
        children:       { type: 'array', items: { $ref: '#/definitions/page' } }
      }
    }
  }
});
const _notePagePatchSchema = {
  type: 'object', required: ['id'], additionalProperties: false,
  properties: {
    id:             { type: 'string', minLength: 1 },
    title:          { type: 'string' },
    description:    { type: 'string' },
    link:           { type: 'string' },
    linkedCards:    { type: 'array', items: { type: 'string' } },
    hasAttachments: { type: 'boolean' },
    attachments:    { type: 'array', items: { type: 'string' } },
    lastModified:   { type: 'string' }
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

function schemaError(validate) {
  return validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

module.exports = { validateBoard, validateBoardPatch, validateNotes, validateNotesPatch, validateInboxCards, schemaError };

'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

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

function schemaError(validate) {
  return validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
}

module.exports = { validateNotes, validateNotesPatch, schemaError };

#!/usr/bin/env node
import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.KANBAN_URL || "http://localhost:3000";
const KEY  = process.env.API_KEY || process.env.KANBAN_API_KEY;

if (!KEY) {
  console.error("kanban-mcp: API_KEY or KANBAN_API_KEY environment variable is required");
  process.exit(1);
}

// ---- HTTP helpers ----

function authHeaders() {
  return { "x-api-key": KEY, "Content-Type": "application/json" };
}

async function api(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r    = await fetch(`${BASE}${path}`, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ---- MCP server ----

const server = new McpServer({ name: "kanban", version: "1.0.0" });

// list_boards
server.tool(
  "list_boards",
  "List all kanban boards with card counts and metadata",
  {},
  async () => ok(await api("GET", "/api/boards"))
);

// get_board
server.tool(
  "get_board",
  "Get the full state of a board — all columns and their cards with all fields",
  { board: z.string().describe("Board name") },
  async ({ board }) => ok(await api("GET", `/api/${encodeURIComponent(board)}/board`))
);

// add_card
server.tool(
  "add_card",
  "Add a card to a board. Lands in the Inbox column by default.",
  {
    board:       z.string().describe("Board name"),
    text:        z.string().describe("Card title"),
    description: z.string().optional().describe("Markdown description"),
    priority:    z.number().int().min(1).max(5).optional().describe("Priority: 1 (highest) – 5 (lowest)"),
    color:       z.string().optional().describe("Hex color, e.g. #10b981"),
    link:        z.string().url().optional().describe("URL to attach to the card"),
  },
  async ({ board, text: cardText, description, priority, color, link }) => {
    const card = { text: cardText };
    if (description !== undefined) card.description = description;
    if (priority    !== undefined) card.priority    = priority;
    if (color       !== undefined) card.color       = color;
    if (link        !== undefined) card.link        = link;
    return ok(await api("POST", `/api/${encodeURIComponent(board)}/import`, [card]));
  }
);

// move_card
server.tool(
  "move_card",
  "Move a card (matched by its exact text) to another column",
  {
    board:     z.string().describe("Board name"),
    card_text: z.string().describe("Exact text of the card to move"),
    to_column: z.string().describe("Target column name (case-insensitive)"),
  },
  async ({ board, card_text, to_column }) => {
    const result = await api(
      "POST",
      `/api/${encodeURIComponent(board)}/move-to/${encodeURIComponent(to_column)}`,
      { "job-title": card_text }
    );
    if (!result.success) throw new Error(`Card not found or column "${to_column}" does not exist`);
    return ok(result);
  }
);

// update_card
server.tool(
  "update_card",
  "Update fields on a card identified by its id (visible in get_board output)",
  {
    board:       z.string().describe("Board name"),
    card_id:     z.string().describe("Card id, e.g. id-abc123"),
    text:        z.string().optional().describe("New card title"),
    description: z.string().optional().describe("New Markdown description (empty string to clear)"),
    priority:    z.number().int().min(0).max(5).optional().describe("Priority 1–5, or 0 to clear"),
    color:       z.string().optional().describe("Hex color, or empty string to clear"),
    link:        z.string().optional().describe("URL, or empty string to clear"),
    done:        z.boolean().optional().describe("Mark as done (true) or undone (false)"),
  },
  async ({ board, card_id, ...fields }) => {
    const data = await api("GET", `/api/${encodeURIComponent(board)}/board`);

    let targetCol  = null;
    let targetCard = null;
    for (const col of data.columns) {
      const c = col.cards.find(c => c.id === card_id);
      if (c) { targetCol = col; targetCard = c; break; }
    }
    if (!targetCard) throw new Error(`Card "${card_id}" not found`);

    if (fields.text        !== undefined) targetCard.text = fields.text;
    if (fields.description !== undefined) {
      if (fields.description === "") delete targetCard.description;
      else targetCard.description = fields.description;
    }
    if (fields.priority !== undefined) {
      if (fields.priority === 0) delete targetCard.priority;
      else targetCard.priority = fields.priority;
    }
    if (fields.color !== undefined) {
      if (fields.color === "") delete targetCard.color;
      else targetCard.color = fields.color;
    }
    if (fields.link !== undefined) {
      if (fields.link === "") delete targetCard.link;
      else targetCard.link = fields.link;
    }
    if (fields.done !== undefined) {
      targetCard.done  = fields.done;
      targetCard.doneAt = fields.done ? new Date().toISOString() : null;
    }
    targetCard.lastModified = new Date().toISOString();

    await api("PATCH", `/api/${encodeURIComponent(board)}/board`, { updatedColumns: [targetCol] });
    return ok({ ok: true, card: targetCard });
  }
);

// delete_card
server.tool(
  "delete_card",
  "Delete a card from a board by its id",
  {
    board:   z.string().describe("Board name"),
    card_id: z.string().describe("Card id, e.g. id-abc123"),
  },
  async ({ board, card_id }) => {
    const data = await api("GET", `/api/${encodeURIComponent(board)}/board`);

    let targetCol = null;
    for (const col of data.columns) {
      const idx = col.cards.findIndex(c => c.id === card_id);
      if (idx !== -1) { col.cards.splice(idx, 1); targetCol = col; break; }
    }
    if (!targetCol) throw new Error(`Card "${card_id}" not found`);

    await api("PATCH", `/api/${encodeURIComponent(board)}/board`, { updatedColumns: [targetCol] });
    return ok({ ok: true });
  }
);

// get_notes
server.tool(
  "get_notes",
  "Get the notes document for a board (all pages and folders)",
  { board: z.string().describe("Board name") },
  async ({ board }) => ok(await api("GET", `/api/${encodeURIComponent(board)}/notes`))
);

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

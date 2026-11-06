import { describe, it, expect, vi, afterEach } from "vitest";
import { Client }           from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer }      from "./server.js";

const BASE = "http://localhost:3000";
const KEY  = "test-key";

// ---- Helpers ----

function mockFetch(...responses) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const { status = 200, body } = responses[i++] || { body: {} };
    return { ok: status < 400, status, json: async () => body };
  }));
}

function fetchMock() {
  return vi.mocked(globalThis.fetch);
}

async function createClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildServer(BASE, KEY).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0" });
  await client.connect(clientTransport);
  return client;
}

function parse(result) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

afterEach(() => vi.unstubAllGlobals());

// ---- Fixtures ----

const BOARDS = [{ name: "work", cardCount: 3 }, { name: "personal", cardCount: 1 }];

const BOARD = {
  columns: [
    {
      id: "col-1",
      title: "Inbox",
      cards: [
        { id: "id-abc123", text: "Fix bug", priority: 2, color: "#ef4444" },
        { id: "id-def456", text: "Write docs" },
      ],
    },
    { id: "col-2", title: "Done", cards: [] },
  ],
};

const NOTES = {
  schemaVersion: 2,
  items: [{ type: "page", id: "n-aaa", title: "Ideas", description: "Some text" }],
};

// ---- Tests ----

describe("list_boards", () => {
  it("returns board list", async () => {
    mockFetch({ body: BOARDS });
    const client = await createClient();
    const result = parse(await client.callTool({ name: "list_boards", arguments: {} }));
    expect(result).toEqual(BOARDS);
    const [url, opts] = fetchMock().mock.calls[0];
    expect(url).toBe(`${BASE}/api/boards`);
    expect(opts.headers["x-api-key"]).toBe(KEY);
  });
});

describe("get_board", () => {
  it("returns full board state", async () => {
    mockFetch({ body: BOARD });
    const client = await createClient();
    const result = parse(await client.callTool({ name: "get_board", arguments: { board: "work" } }));
    expect(result.columns).toHaveLength(2);
    expect(fetchMock().mock.calls[0][0]).toBe(`${BASE}/api/work/board`);
  });

  it("URL-encodes board name", async () => {
    mockFetch({ body: BOARD });
    const client = await createClient();
    await client.callTool({ name: "get_board", arguments: { board: "my board" } });
    expect(fetchMock().mock.calls[0][0]).toBe(`${BASE}/api/my%20board/board`);
  });
});

describe("add_card", () => {
  it("posts card to import endpoint", async () => {
    mockFetch({ body: { relevant: 1, excluded: 0 } });
    const client = await createClient();
    await client.callTool({ name: "add_card", arguments: { board: "work", text: "New task" } });
    const [url, opts] = fetchMock().mock.calls[0];
    expect(url).toBe(`${BASE}/api/work/import`);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual([{ text: "New task" }]);
  });

  it("includes optional fields when provided", async () => {
    mockFetch({ body: { relevant: 1 } });
    const client = await createClient();
    await client.callTool({
      name: "add_card",
      arguments: { board: "work", text: "Task", description: "Details", priority: 1, color: "#10b981", link: "https://example.com" },
    });
    const body = JSON.parse(fetchMock().mock.calls[0][1].body);
    expect(body[0]).toMatchObject({ text: "Task", description: "Details", priority: 1, color: "#10b981", link: "https://example.com" });
  });
});

describe("move_card", () => {
  it("moves card and returns result", async () => {
    const moveResult = { success: true, moved: { id: "id-abc123", text: "Fix bug" }, toColumn: "Done" };
    mockFetch({ body: moveResult });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "move_card",
      arguments: { board: "work", card_text: "Fix bug", to_column: "Done" },
    }));
    expect(result.success).toBe(true);
    const [url, opts] = fetchMock().mock.calls[0];
    expect(url).toBe(`${BASE}/api/work/move-to/Done`);
    expect(JSON.parse(opts.body)).toEqual({ "job-title": "Fix bug" });
  });

  it("returns error when card not found", async () => {
    mockFetch({ body: { success: false } });
    const client = await createClient();
    const result = await client.callTool({
      name: "move_card",
      arguments: { board: "work", card_text: "Ghost card", to_column: "Done" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("update_card", () => {
  it("fetches board, updates card fields, and patches back", async () => {
    mockFetch({ body: BOARD }, { body: { ok: true } });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "update_card",
      arguments: { board: "work", card_id: "id-abc123", text: "Fixed bug", priority: 1 },
    }));
    expect(result.ok).toBe(true);
    expect(result.card.text).toBe("Fixed bug");
    expect(result.card.priority).toBe(1);

    const [patchUrl, patchOpts] = fetchMock().mock.calls[1];
    expect(patchUrl).toBe(`${BASE}/api/work/board`);
    expect(patchOpts.method).toBe("PATCH");
    const patchBody = JSON.parse(patchOpts.body);
    const updatedCard = patchBody.updatedColumns[0].cards.find(c => c.id === "id-abc123");
    expect(updatedCard.text).toBe("Fixed bug");
  });

  it("clears priority when 0 is passed", async () => {
    mockFetch({ body: BOARD }, { body: { ok: true } });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "update_card",
      arguments: { board: "work", card_id: "id-abc123", priority: 0 },
    }));
    expect(result.card.priority).toBeUndefined();
  });

  it("clears color when empty string is passed", async () => {
    mockFetch({ body: BOARD }, { body: { ok: true } });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "update_card",
      arguments: { board: "work", card_id: "id-abc123", color: "" },
    }));
    expect(result.card.color).toBeUndefined();
  });

  it("sets doneAt when marking done", async () => {
    mockFetch({ body: BOARD }, { body: { ok: true } });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "update_card",
      arguments: { board: "work", card_id: "id-abc123", done: true },
    }));
    expect(result.card.done).toBe(true);
    expect(result.card.doneAt).toBeTruthy();
  });

  it("returns error when card id not found", async () => {
    mockFetch({ body: BOARD });
    const client = await createClient();
    const result = await client.callTool({
      name: "update_card",
      arguments: { board: "work", card_id: "id-nope", text: "x" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("delete_card", () => {
  it("removes card and patches board", async () => {
    mockFetch({ body: BOARD }, { body: { ok: true } });
    const client = await createClient();
    const result = parse(await client.callTool({
      name: "delete_card",
      arguments: { board: "work", card_id: "id-abc123" },
    }));
    expect(result.ok).toBe(true);

    const patchBody = JSON.parse(fetchMock().mock.calls[1][1].body);
    const remaining = patchBody.updatedColumns[0].cards;
    expect(remaining.find(c => c.id === "id-abc123")).toBeUndefined();
    expect(remaining.find(c => c.id === "id-def456")).toBeDefined();
  });

  it("returns error when card id not found", async () => {
    mockFetch({ body: BOARD });
    const client = await createClient();
    const result = await client.callTool({
      name: "delete_card",
      arguments: { board: "work", card_id: "id-nope" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("get_notes", () => {
  it("returns notes document", async () => {
    mockFetch({ body: NOTES });
    const client = await createClient();
    const result = parse(await client.callTool({ name: "get_notes", arguments: { board: "work" } }));
    expect(result.schemaVersion).toBe(2);
    expect(result.items[0].title).toBe("Ideas");
    expect(fetchMock().mock.calls[0][0]).toBe(`${BASE}/api/work/notes`);
  });
});

describe("auth header", () => {
  it("sends x-api-key on every request", async () => {
    mockFetch({ body: BOARDS });
    const client = await createClient();
    await client.callTool({ name: "list_boards", arguments: {} });
    expect(fetchMock().mock.calls[0][1].headers["x-api-key"]).toBe(KEY);
  });
});

describe("API error handling", () => {
  it("returns error when API responds with non-2xx", async () => {
    mockFetch({ status: 401, body: { error: "Unauthorized" } });
    const client = await createClient();
    const result = await client.callTool({ name: "list_boards", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unauthorized");
  });
});

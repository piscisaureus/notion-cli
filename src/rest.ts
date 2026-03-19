/**
 * Notion REST API client for database operations.
 *
 * Uses the public integration OAuth token (separate from MCP tokens)
 * to access the Notion REST API at api.notion.com.
 */

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getEnvPath(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  return `${home}/d/notion-cli/.env.sh`;
}

let _apiToken: string | null = null;

async function getApiToken(): Promise<string> {
  if (_apiToken) return _apiToken;

  // Try environment variable first.
  const envToken = Deno.env.get("NOTION_API_TOKEN");
  if (envToken) {
    _apiToken = envToken;
    return envToken;
  }

  // Parse from .env.sh.
  try {
    const text = await Deno.readTextFile(getEnvPath());
    const match = text.match(/NOTION_API_TOKEN="([^"]+)"/);
    if (match) {
      _apiToken = match[1];
      return match[1];
    }
  } catch { /* ignore */ }

  throw new Error(
    "No Notion API token found. Set NOTION_API_TOKEN or create .env.sh",
  );
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getApiToken();
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await resp.json();
  if (data.object === "error") {
    throw new Error(`Notion API error (${data.code}): ${data.message}`);
  }
  return data;
}

// ─── Property extraction ─────────────────────────────────────────────

interface NotionProperty {
  type: string;
  [key: string]: unknown;
}

/** Extract a plain value from a Notion property object. */
function extractPropertyValue(prop: NotionProperty): string {
  switch (prop.type) {
    case "title": {
      const arr = prop.title as Array<{ plain_text: string }>;
      return arr?.map((t) => t.plain_text).join("") ?? "";
    }
    case "rich_text": {
      const arr = prop.rich_text as Array<{ plain_text: string }>;
      return arr?.map((t) => t.plain_text).join("") ?? "";
    }
    case "number":
      return String(prop.number ?? "");
    case "select":
      return (prop.select as { name: string } | null)?.name ?? "";
    case "multi_select": {
      const arr = prop.multi_select as Array<{ name: string }>;
      return arr?.map((s) => s.name).join(", ") ?? "";
    }
    case "date": {
      const d = prop.date as { start?: string; end?: string } | null;
      if (!d) return "";
      return d.end ? `${d.start} - ${d.end}` : d.start ?? "";
    }
    case "checkbox":
      return prop.checkbox ? "true" : "false";
    case "url":
      return (prop.url as string) ?? "";
    case "email":
      return (prop.email as string) ?? "";
    case "phone_number":
      return (prop.phone_number as string) ?? "";
    case "created_time":
      return (prop.created_time as string) ?? "";
    case "last_edited_time":
      return (prop.last_edited_time as string) ?? "";
    case "created_by":
    case "last_edited_by": {
      const user = prop[prop.type] as { name?: string } | null;
      return user?.name ?? "";
    }
    case "status":
      return (prop.status as { name: string } | null)?.name ?? "";
    case "formula": {
      const f = prop.formula as {
        type: string;
        string?: string;
        number?: number;
        boolean?: boolean;
        date?: { start?: string };
      };
      if (f.type === "string") return f.string ?? "";
      if (f.type === "number") return String(f.number ?? "");
      if (f.type === "boolean") return String(f.boolean ?? "");
      if (f.type === "date") return f.date?.start ?? "";
      return "";
    }
    case "relation": {
      const arr = prop.relation as Array<{ id: string }>;
      return arr?.map((r) => r.id).join(", ") ?? "";
    }
    case "rollup": {
      const r = prop.rollup as { type: string; array?: unknown[] };
      if (r.type === "array" && r.array) return JSON.stringify(r.array);
      return "";
    }
    case "people": {
      const arr = prop.people as Array<{ name?: string }>;
      return arr?.map((p) => p.name ?? "").join(", ") ?? "";
    }
    case "files": {
      const arr = prop.files as Array<{ name: string }>;
      return arr?.map((f) => f.name).join(", ") ?? "";
    }
    default:
      return JSON.stringify(prop[prop.type] ?? "");
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export interface DatabaseSchema {
  id: string;
  title: string;
  properties: Record<string, { type: string; name: string }>;
}

export interface DatabaseRow {
  id: string;
  url: string;
  values: Record<string, string>;
}

/** Get the schema of a database. */
export async function getDatabaseSchema(
  databaseId: string,
): Promise<DatabaseSchema> {
  const data = await apiRequest("GET", `/databases/${databaseId}`) as {
    id: string;
    title: Array<{ plain_text: string }>;
    properties: Record<string, { type: string; name: string }>;
  };
  return {
    id: data.id,
    title: data.title?.map((t) => t.plain_text).join("") ?? "",
    properties: Object.fromEntries(
      Object.entries(data.properties).map(([k, v]) => [k, {
        type: v.type,
        name: v.name,
      }]),
    ),
  };
}

/** Query all rows from a database, handling pagination. */
export async function queryDatabase(
  databaseId: string,
  sorts?: Array<{ property: string; direction: "ascending" | "descending" }>,
): Promise<{ schema: DatabaseSchema; rows: DatabaseRow[] }> {
  const schema = await getDatabaseSchema(databaseId);
  const rows: DatabaseRow[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const data = await apiRequest(
      "POST",
      `/databases/${databaseId}/query`,
      body,
    ) as {
      results: Array<{
        id: string;
        url: string;
        properties: Record<string, NotionProperty>;
      }>;
      has_more: boolean;
      next_cursor: string | null;
    };

    for (const page of data.results) {
      const values: Record<string, string> = {};
      for (const [name, prop] of Object.entries(page.properties)) {
        values[name] = extractPropertyValue(prop);
      }
      rows.push({ id: page.id, url: page.url, values });
    }

    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return { schema, rows };
}

/** Format database rows as CSV. */
export function formatCsv(
  columns: string[],
  rows: DatabaseRow[],
): string {
  const escape = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines: string[] = [];
  lines.push(columns.map(escape).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row.values[c] ?? "")).join(","));
  }
  return lines.join("\n");
}

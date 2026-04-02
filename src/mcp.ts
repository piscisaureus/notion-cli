/**
 * MCP client for Notion's hosted MCP server (mcp.notion.com).
 *
 * Handles OAuth token refresh, MCP session initialization, and
 * JSON-RPC tool calls over HTTP with SSE response parsing.
 */

const MCP_URL = "https://mcp.notion.com/mcp";
const TOKEN_URL = "https://mcp.notion.com/token";
const AUTHORIZE_URL = "https://mcp.notion.com/authorize";
const REGISTER_URL = "https://mcp.notion.com/register";
const CLIENT_ID = "6wAreBipt0Yz9WvQ";
const PROTOCOL_VERSION = "2025-03-26";

// ─── Token management ────────────────────────────────────────────────

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id?: string;
}

export function getTokenPath(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "";
  return `${home}/.notion/tokens.json`;
}

async function readTokens(): Promise<Tokens> {
  const path = getTokenPath();
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    throw new Error(
      `Cannot read tokens from ${path}: ${e}\n` +
        `Run 'notion auth login' to authenticate.`,
    );
  }
}

async function writeTokens(tokens: Tokens): Promise<void> {
  const path = getTokenPath();
  await Deno.writeTextFile(path, JSON.stringify(tokens));
  if (Deno.build.os !== "windows") {
    await Deno.chmod(path, 0o600);
  }
}

async function refreshTokens(tokens: Tokens): Promise<Tokens> {
  const clientId = tokens.client_id ?? CLIENT_ID;
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
  }

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + (data.expires_in ?? 3600),
    client_id: clientId,
  };
}

async function getAccessToken(): Promise<string> {
  let tokens = await readTokens();
  const now = Math.floor(Date.now() / 1000);

  // Refresh if token expires within 5 minutes.
  if (now >= tokens.expires_at - 300) {
    tokens = await refreshTokens(tokens);
    await writeTokens(tokens);
  }

  return tokens.access_token;
}

// ─── OAuth login ─────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(hash));
}

async function registerClient(redirectUri: string): Promise<string> {
  const resp = await fetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "notion-cli",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Client registration failed (HTTP ${resp.status}): ${text}`,
    );
  }
  const data = await resp.json();
  if (!data.client_id) {
    throw new Error(
      `Client registration failed: ${JSON.stringify(data)}`,
    );
  }
  return data.client_id as string;
}

const CALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>Notion CLI</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
align-items:center;height:100vh;margin:0;background:#f7f7f7}
.box{text-align:center;padding:2rem}</style></head>
<body><div class="box"><h2>TITLE</h2><p>MSG</p></div></body></html>`;

export async function login(): Promise<void> {
  // Resolve the auth code from the OAuth callback via a promise.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const ac = new AbortController();
  const server = Deno.serve({
    port: 0,
    signal: ac.signal,
    onListen() {},
  }, (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") {
      return new Response("Not found", { status: 404 });
    }
    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      rejectCode(new Error(`Authorization denied: ${desc}`));
      const html = CALLBACK_HTML
        .replace("TITLE", "Authorization Failed")
        .replace("MSG", "You can close this tab.");
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }
    const code = url.searchParams.get("code");
    if (code) {
      resolveCode(code);
      const html = CALLBACK_HTML
        .replace("TITLE", "Authorized")
        .replace("MSG", "You can close this tab.");
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("Missing code", { status: 400 });
  });

  try {
    const port = server.addr.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const clientId = await registerClient(redirectUri);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const authUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    })}`;

    // Try to open the browser.
    const openCmd = Deno.build.os === "darwin"
      ? "open"
      : Deno.build.os === "windows"
      ? "cmd"
      : "xdg-open";
    const openArgs = Deno.build.os === "windows"
      ? ["/c", "start", authUrl]
      : [authUrl];
    try {
      await new Deno.Command(openCmd, {
        args: openArgs,
        stderr: "null",
        stdout: "null",
      }).output();
    } catch {
      // Browser open failed; user can copy the URL.
    }

    console.log(`Open this URL to authorize:\n\n  ${authUrl}\n`);
    console.log("Waiting for authorization...");

    const code = await codePromise;

    // Exchange authorization code for tokens.
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(
        `Token exchange failed (HTTP ${tokenResp.status}): ${text}`,
      );
    }

    const data = await tokenResp.json();
    if (!data.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const tokens: Tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: now + (data.expires_in ?? 3600),
      client_id: clientId,
    };

    // Ensure ~/.notion/ directory exists.
    const dir = getTokenPath().replace(/[/\\][^/\\]+$/, "");
    await Deno.mkdir(dir, { recursive: true });

    await writeTokens(tokens);
    console.log("Authenticated successfully.");
  } finally {
    ac.abort();
    await server.finished;
  }
}

export async function logout(): Promise<void> {
  const path = getTokenPath();
  try {
    await Deno.remove(path);
    console.log(`Removed ${path}`);
  } catch {
    console.log("Already logged out (no tokens found).");
  }
}

// ─── MCP protocol ────────────────────────────────────────────────────

function mcpHeaders(
  accessToken: string,
  sessionId?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    h["Mcp-Session-Id"] = sessionId;
  }
  return h;
}

function parseSSE(body: string): Record<string, unknown> {
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return JSON.parse(body);
}

// ─── Public API ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentItem {
  type: string;
  text?: string;
}

export interface McpResult {
  content: McpContentItem[];
  isError?: boolean;
}

export class NotionClient {
  #accessToken: string;
  #sessionId: string;

  private constructor(accessToken: string, sessionId: string) {
    this.#accessToken = accessToken;
    this.#sessionId = sessionId;
  }

  static async create(): Promise<NotionClient> {
    const accessToken = await getAccessToken();

    // Initialize MCP session.
    const initResp = await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "notion-cli", version: "1.0" },
        },
      }),
    });

    const sessionId = initResp.headers.get("mcp-session-id");
    await initResp.text(); // Consume body.

    if (!sessionId) {
      throw new Error(
        "Failed to get MCP session ID. Check your tokens and network.",
      );
    }

    // Send initialized notification.
    const notifResp = await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(accessToken, sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    await notifResp.text();

    return new NotionClient(accessToken, sessionId);
  }

  async call(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<McpResult> {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(this.#accessToken, this.#sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    const body = await resp.text();
    const data = parseSSE(body);

    if (data.error) {
      const err = data.error as Record<string, unknown>;
      throw new Error(
        `MCP error: ${err.message ?? JSON.stringify(err, null, 2)}`,
      );
    }

    return (data.result as McpResult) ?? { content: [] };
  }

  async listTools(): Promise<ToolDefinition[]> {
    const resp = await fetch(MCP_URL, {
      method: "POST",
      headers: mcpHeaders(this.#accessToken, this.#sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    const body = await resp.text();
    const data = parseSSE(body);
    const result = data.result as Record<string, unknown>;
    return (result.tools as ToolDefinition[]) ?? [];
  }
}

// ─── Notion markup <-> Markdown transforms ───────────────────────────

const LIST_RE = /^(\d+\.\s|[-*+]\s)/;

/**
 * Apply replacement functions to text, handling inline code separately.
 * `outsideFn` transforms text outside backtick spans.
 * `insideFn` transforms text inside backtick spans (optional, default: identity).
 */
function transformByInlineCode(
  line: string,
  outsideFn: (text: string) => string,
  insideFn?: (text: string) => string,
): string {
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let ticks = 0;
      const start = i;
      while (i < line.length && line[i] === "`") {
        ticks++;
        i++;
      }
      const opener = line.slice(start, i);
      const closeIdx = line.indexOf(opener, i);
      if (closeIdx !== -1) {
        const content = line.slice(i, closeIdx);
        parts.push(
          opener + (insideFn ? insideFn(content) : content) + opener,
        );
        i = closeIdx + ticks;
      } else {
        parts.push(outsideFn(opener));
      }
    } else {
      let j = i;
      while (j < line.length && line[j] !== "`") j++;
      parts.push(outsideFn(line.slice(i, j)));
      i = j;
    }
  }
  return parts.join("");
}

/**
 * Convert Notion MCP markup (from <content> blocks) to standard markdown.
 *
 * Transformations:
 *  - Prepend page title as `# Title`
 *  - `\$` -> `$`
 *  - One blank line between blocks (except consecutive list items)
 *  - `<empty-block/>` -> extra blank line (so two blank lines total)
 *
 * Tags like `<video>`, `<image>` etc. are left as-is to preserve
 * round-trippability (they contain metadata we can't reconstruct).
 */
function notionToMarkdown(mcpText: string, title?: string): string {
  const lines = mcpText.split("\n");
  const out: string[] = [];
  let inCodeFence = false;
  let codeFenceIndent = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Track code fences (may be indented inside list items).
    if (line.trimStart().startsWith("```")) {
      if (!inCodeFence) {
        inCodeFence = true;
        // Remember the indentation of the opening fence so we can
        // indent code content to match (required for valid markdown
        // when code blocks are inside list items).
        codeFenceIndent = line.match(/^(\s*)/)?.[1] ?? "";
      } else {
        inCodeFence = false;
        codeFenceIndent = "";
      }
    } else if (inCodeFence && codeFenceIndent) {
      // Indent code content to match the fence indentation.
      line = codeFenceIndent + line;
    }

    // Unescape Notion markup escapes, but only outside code fences
    // and inline code spans.
    if (!inCodeFence) {
      line = transformByInlineCode(
        line,
        (t) => t.replaceAll("\\$", "$").replaceAll("\\*", "*"),
      );
    }

    if (!inCodeFence && line === "<empty-block/>") {
      // Emit an extra blank line (on top of the separator already added
      // after the previous block).
      out.push("");
    } else {
      out.push(line);
      // Add a blank line after this block, unless inside a code fence
      // or between consecutive list items.
      if (!inCodeFence && i < lines.length - 1) {
        const next = lines[i + 1];
        if (!(LIST_RE.test(line) && LIST_RE.test(next))) {
          out.push("");
        }
      }
    }
  }

  let result = out.join("\n");
  if (title) {
    result = `# ${title}\n\n${result}`;
  }
  return result.trimEnd();
}

/**
 * Convert standard markdown back to Notion MCP markup for upload.
 *
 * Reverse of notionToMarkdown:
 *  - Strip leading `# Title` heading (title is set via properties)
 *  - `$` -> `\$`
 *  - Single blank line between blocks -> single `\n`
 *  - Two+ blank lines -> `<empty-block/>` for each extra blank line
 */
// A line that starts a new block (not a paragraph continuation).
const BLOCK_START_RE =
  /^(\s*```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s|<[a-z_]|<\/|<empty-block\/>|\|)/;

/** Strip a leading URL line (from `notion get` output) if present. */
function stripLeadingUrl(markdown: string): string {
  return markdown.replace(/^https?:\/\/[^\n]*\n\n?/, "");
}

/** Extract the title from a `# Title` heading at the start of markdown. */
export function extractMarkdownTitle(markdown: string): string | undefined {
  const cleaned = stripLeadingUrl(markdown);
  const m = cleaned.match(/^# ([^\n]+)/);
  return m ? m[1].trim() : undefined;
}

export function markdownToNotion(markdown: string): string {
  // Strip leading URL line (from `notion get` output) and title heading.
  const withoutUrl = stripLeadingUrl(markdown);
  const text = withoutUrl.replace(/^# [^\n]+\n/, "");

  // Phase 1: unwrap soft-wrapped paragraphs.
  // Join consecutive plain-text lines into single lines. A line ending
  // with two spaces becomes a <br> (hard line break) instead of a space.
  // Lines inside code fences and block-level elements are not joined.
  const lines = text.split("\n");
  const unwrapped: string[] = [];
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
    }

    // Inside code fences, emit as-is.
    if (inCodeFence) {
      unwrapped.push(line);
      continue;
    }

    // Blank lines and block-level lines start fresh.
    if (line === "" || BLOCK_START_RE.test(line)) {
      unwrapped.push(line);
      continue;
    }

    // Plain text line: check if we should join with the previous line.
    // Join if: (a) prev is a plain text line, or (b) prev is a list item
    // and this line is an indented continuation of it.
    const prev = unwrapped.length > 0 ? unwrapped[unwrapped.length - 1] : "";
    const prevIsPlain = prev !== "" && !BLOCK_START_RE.test(prev) &&
      !prev.trimStart().startsWith("```");
    const prevIsList = LIST_RE.test(prev);
    const isIndentedContinuation = /^\s+/.test(line);

    if (
      unwrapped.length > 0 &&
      (prevIsPlain || (prevIsList && isIndentedContinuation))
    ) {
      // Join with previous line.
      const trimmedLine = isIndentedContinuation ? line.trimStart() : line;
      if (prev.endsWith("  ")) {
        // Trailing two spaces = hard line break.
        unwrapped[unwrapped.length - 1] = prev.slice(0, -2) + "<br>" +
          trimmedLine;
      } else {
        unwrapped[unwrapped.length - 1] = prev + " " + trimmedLine;
      }
    } else {
      unwrapped.push(line);
    }
  }

  // Phase 2: collapse blank lines, escape characters, and strip code
  // fence indentation (reverse of the indentation added on export).
  const out: string[] = [];
  let i = 0;
  inCodeFence = false;
  let codeFenceIndent = "";
  while (i < unwrapped.length) {
    if (unwrapped[i].trimStart().startsWith("```")) {
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceIndent = unwrapped[i].match(/^(\s*)/)?.[1] ?? "";
      } else {
        inCodeFence = false;
        codeFenceIndent = "";
      }
    }

    if (!inCodeFence && unwrapped[i] === "") {
      let blanks = 0;
      while (i < unwrapped.length && unwrapped[i] === "") {
        blanks++;
        i++;
      }
      // First blank line is the normal block separator (becomes \n in
      // the output via join). Each extra one becomes <empty-block/>.
      for (let j = 1; j < blanks; j++) {
        out.push("<empty-block/>");
      }
    } else {
      let line = unwrapped[i];
      if (
        inCodeFence && codeFenceIndent && !line.trimStart().startsWith("```")
      ) {
        // Strip the fence indentation from code content lines.
        if (line.startsWith(codeFenceIndent)) {
          line = line.slice(codeFenceIndent.length);
        }
      }
      // Escape $ outside code fences and inline code spans.
      // Inside inline code, escape <br> so it's not interpreted as
      // a line break by the MCP server.
      if (!inCodeFence) {
        line = transformByInlineCode(
          line,
          (t) => t.replaceAll("$", "\\$"),
        );
      }
      out.push(line);
      i++;
    }
  }

  return out.join("\n").trimEnd();
}

/**
 * Extract content from the MCP response text envelope.
 * Pages have <content>...</content>, databases have structured XML.
 */
function extractContent(
  text: string,
  title?: string,
): string {
  const contentMatch = text.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  if (contentMatch) {
    return notionToMarkdown(contentMatch[1], title);
  }

  // For databases, extract the SQL DDL as readable content.
  const ddlMatch = text.match(/<sqlite-table>\n?([\s\S]*?)\n?<\/sqlite-table>/);
  if (ddlMatch) {
    const lines: string[] = [];
    if (title) lines.push(`# ${title}`, "");
    lines.push(ddlMatch[1].trim());
    return lines.join("\n");
  }

  // For other structured responses, strip the preamble line.
  return text.replace(
    /^Here is the result of "[^"]*" for the \w+ with URL [^\n]+\n/,
    "",
  ).trim();
}

/** Structured result from a notion-fetch call. */
export interface FetchedPage {
  title?: string;
  url?: string;
  type?: string;
  markdown: string;
  metadata: Record<string, unknown>;
}

/** Parse a notion-fetch result into structured parts. */
export function parseFetchResult(result: McpResult): FetchedPage | null {
  for (const item of result.content) {
    if (!item.text) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
        const markdown = extractContent(parsed.text, parsed.title);
        const { text: _text, ...metadata } = parsed;

        // For databases, extract the data source ID for round-tripping.
        if (parsed.metadata?.type === "database") {
          const dsMatch = (parsed.text as string).match(
            /<data-source url="{{(collection:\/\/[^}]+)}}"/,
          );
          if (dsMatch) {
            metadata.data_source_id = dsMatch[1];
          }
        }

        return {
          title: parsed.title,
          url: parsed.url,
          type: parsed.metadata?.type,
          markdown,
          metadata,
        };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

/** Format MCP result content for display. */
export function formatResult(result: McpResult, json = false): string {
  const parts: string[] = [];
  for (const item of result.content) {
    if (item.text) {
      if (json) {
        try {
          parts.push(JSON.stringify(JSON.parse(item.text), null, 2));
        } catch {
          parts.push(item.text);
        }
      } else {
        try {
          const parsed = JSON.parse(item.text);
          if (
            typeof parsed === "object" && parsed !== null && "text" in parsed
          ) {
            const cleaned = extractContent(parsed.text, parsed.title);
            parts.push(cleaned);
          } else {
            parts.push(JSON.stringify(parsed, null, 2));
          }
        } catch {
          parts.push(item.text);
        }
      }
    }
  }
  return parts.join("\n");
}

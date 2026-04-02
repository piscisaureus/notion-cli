#!/usr/bin/env -S deno run -A
/**
 * Notion CLI - Access your Notion workspace from the command line.
 *
 * Wraps Notion's hosted MCP server (mcp.notion.com) in a user-friendly
 * command-line interface with subcommands for all supported operations.
 */

import {
  extractMarkdownTitle,
  formatResult,
  getTokenPath,
  login,
  logout,
  markdownToNotion,
  NotionClient,
  parseFetchResult,
} from "./mcp.ts";

const VERSION = "0.1.0";

// ─── Argument parsing ────────────────────────────────────────────────

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const result: Args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      (result._ as string[]).push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg[1];
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        result[key] = argv[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i++;
      }
    } else {
      (result._ as string[]).push(arg);
      i++;
    }
  }
  return result;
}

function opt(args: Args, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

function flag(args: Args, ...names: string[]): boolean {
  return names.some((n) => args[n] === true);
}

function requireOpt(args: Args, name: string): string {
  const v = opt(args, name);
  if (!v) die(`missing required option: --${name}`);
  return v;
}

function requirePos(args: Args, index: number, label: string): string {
  const v = (args._ as string[])[index];
  if (!v) die(`missing required argument: <${label}>`);
  return v;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

function wantHelp(args: Args): boolean {
  return flag(args, "help", "h");
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const buf = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Get content from --content, --content-file, or --stdin.
 * Stdin is only read when explicitly requested via --stdin flag.
 */
async function getContent(
  args: Args,
  required = false,
): Promise<string | undefined> {
  const inline = opt(args, "content");
  if (inline) return inline;

  const file = opt(args, "content-file");
  if (file) return await Deno.readTextFile(file);

  if (flag(args, "stdin")) return await readStdin();

  if (required) {
    die(
      "missing content: use --content, --content-file, or --stdin",
    );
  }
  return undefined;
}

/**
 * Extract a Notion page/database ID from a URL or pass through a raw ID.
 * Handles URLs like https://notion.so/workspace/Page-Title-abc123def456
 */
function extractId(urlOrId: string): string {
  if (urlOrId.startsWith("http")) {
    // Extract the 32-char hex ID from the end of the URL path.
    const match = urlOrId.match(/([0-9a-f]{32})(?:[?#]|$)/);
    if (match) return match[1];
    // Try UUID format with dashes.
    const uuidMatch = urlOrId.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/,
    );
    if (uuidMatch) return uuidMatch[1];
    die(`could not extract page ID from URL: ${urlOrId}`);
  }
  return urlOrId;
}

let _client: NotionClient | null = null;
async function client(): Promise<NotionClient> {
  if (!_client) _client = await NotionClient.create();
  return _client;
}

let _jsonOutput = false;

function printResult(result: import("./mcp.ts").McpResult): void {
  console.log(formatResult(result, _jsonOutput));
}

// ─── Commands: search & get ──────────────────────────────────────────

async function cmdSearch(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Search pages and databases in your Notion workspace.

Usage: notion search <query> [options]

Arguments:
  <query>              Text to search for (omit for recent pages)

Options:
  --limit <n>          Maximum number of results (default: 10)
  -h, --help           Show this help

Examples:
  notion search "meeting notes"
  notion search "RFC" --limit 5
  notion search`);
    return;
  }

  const query = (args._ as string[]).join(" ");
  const limit = opt(args, "limit");
  const mcpArgs: Record<string, unknown> = {};
  if (query) mcpArgs.query = query;
  if (limit) mcpArgs.page_size = parseInt(limit);

  const c = await client();
  const result = await c.call("notion-search", mcpArgs);
  printResult(result);
}

async function cmdGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Fetch a page, database, or data source by ID or URL.

Usage: notion get <id-or-url>

Arguments:
  <id-or-url>          Notion page/database ID or URL

Options:
  -h, --help           Show this help

Examples:
  notion get abc123def456
  notion get https://notion.so/My-Page-abc123def456`);
    return;
  }

  const id = extractId(requirePos(args, 0, "id-or-url"));
  const c = await client();
  const result = await c.call("notion-fetch", { id });
  printResult(result);
}

// ─── Commands: page ──────────────────────────────────────────────────

async function cmdPage(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "get":
      return await cmdPageGet(rest);
    case "describe":
    case "desc":
      return await cmdPageDescribe(rest);
    case "edit":
      return await cmdPageEdit(rest);
    case "create":
      return await cmdPageCreate(rest);
    case "update":
      return await cmdPageUpdate(rest);
    case "move":
      return await cmdPageMove(rest);
    case "duplicate":
    case "dup":
      return await cmdPageDuplicate(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage Notion pages.

Usage: notion page <subcommand> [options]

Subcommands:
  get                  Print page content as Markdown
  describe             Print page content and metadata
  edit                 Open page in editor, update on save
  create               Create a new page
  update               Update a page's content or properties
  move                 Move pages to a new parent
  duplicate            Duplicate a page

Run 'notion page <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: page ${sub}\nRun 'notion page --help' for usage.`,
      );
  }
}

async function cmdPageGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Print page content as Markdown.

Usage: notion page get <id-or-url>

Arguments:
  <id-or-url>          Page ID or URL

Options:
  -h, --help           Show this help

The output includes the title as a '# Title' heading. This format
is round-trippable: you can pipe it back to 'notion page update'.

Examples:
  notion page get abc123
  notion page get abc123 > page.md`);
    return;
  }

  const id = extractId(requirePos(args, 0, "id-or-url"));
  const c = await client();
  const result = await c.call("notion-fetch", { id });
  const page = parseFetchResult(result);
  if (page) {
    console.log(page.markdown);
  } else {
    printResult(result);
  }
}

async function cmdPageDescribe(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Print page content and metadata.

Usage: notion page describe <id-or-url>

Arguments:
  <id-or-url>          Page ID or URL

Options:
  -h, --help           Show this help

Prints the page URL and metadata as JSON, followed by the Markdown
content separated by a blank line.

Examples:
  notion page describe abc123`);
    return;
  }

  const id = extractId(requirePos(args, 0, "id-or-url"));
  const c = await client();
  const result = await c.call("notion-fetch", { id });
  const page = parseFetchResult(result);
  if (page) {
    console.log(JSON.stringify(page.metadata, null, 2));
    console.log();
    console.log(page.markdown);
  } else {
    printResult(result);
  }
}

async function cmdPageEdit(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Open a page in your editor, then update it on save.

Usage: notion page edit <id-or-url>

Arguments:
  <id-or-url>          Page ID or URL

Options:
  -h, --help           Show this help

Opens the page content as Markdown in $EDITOR (or $VISUAL, or vi).
When you save and exit, the page is updated with the new content.
If the file is empty or unchanged, the update is skipped.

Examples:
  notion page edit abc123
  EDITOR=code notion page edit abc123`);
    return;
  }

  const id = extractId(requirePos(args, 0, "id-or-url"));
  const c = await client();

  // Fetch current content.
  const result = await c.call("notion-fetch", { id });
  const page = parseFetchResult(result);
  if (!page) die("could not fetch page content");

  const pageId = page.url?.replace(/.*\//, "") ?? id;

  // Write to temp file.
  const tmpFile = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(tmpFile, page.markdown + "\n");

    // Open editor (same precedence as kubectl).
    const editor = Deno.env.get("KUBE_EDITOR") ||
      Deno.env.get("EDITOR") || Deno.env.get("VISUAL") || "vi";
    const editorArgs = editor.split(/\s+/);
    const cmd = new Deno.Command(editorArgs[0], {
      args: [...editorArgs.slice(1), tmpFile],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const proc = await cmd.spawn();
    const status = await proc.status;
    if (!status.success) die(`editor exited with code ${status.code}`);

    // Read back and compare.
    const edited = (await Deno.readTextFile(tmpFile)).trimEnd();
    if (!edited) {
      console.error("File is empty, skipping update.");
      return;
    }
    if (edited === page.markdown) {
      console.error("No changes, skipping update.");
      return;
    }

    // Upload content.
    const updateResult = await c.call("notion-update-page", {
      page_id: pageId,
      command: "replace_content",
      new_str: markdownToNotion(edited),
    });
    printResult(updateResult);

    // Update title if it changed.
    const newTitle = extractMarkdownTitle(edited);
    if (newTitle && newTitle !== page.title) {
      await c.call("notion-update-page", {
        page_id: pageId,
        command: "update_properties",
        properties: { title: newTitle },
      });
      console.error(`Title updated: ${newTitle}`);
    }
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

async function cmdPageCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Create a new Notion page.

Usage: notion page create --parent <id> [--title <title>] [options]

Options:
  --parent <id>        Parent page or database ID (required)
  --title <title>      Page title (extracted from '# Title' in content
                       if not specified)
  --content <md>       Page content in Markdown
  --content-file <f>   Read content from a file
  --stdin              Read content from stdin
  --icon <emoji>       Page icon (emoji character or URL)
  --cover <url>        Cover image URL
  -h, --help           Show this help

Examples:
  notion page create --parent abc --title "My Page"
  cat page.md | notion page create --parent abc --stdin
  notion page create --parent abc --content-file page.md`);
    return;
  }

  const parentId = extractId(requireOpt(args, "parent"));
  const content = await getContent(args);
  const title = opt(args, "title") ??
    (content ? extractMarkdownTitle(content) : undefined);
  if (!title) die("missing title: use --title or start content with '# Title'");
  const icon = opt(args, "icon");
  const cover = opt(args, "cover");

  const page: Record<string, unknown> = {
    properties: { title },
  };
  if (content) page.content = markdownToNotion(content);
  if (icon) page.icon = icon;
  if (cover) page.cover = cover;

  const c = await client();
  const result = await c.call("notion-create-pages", {
    pages: [page],
    parent: { type: "page_id", page_id: parentId },
  });
  printResult(result);
}

async function cmdPageUpdate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Update a Notion page's content or properties.

Usage: notion page update <id> [options]

Arguments:
  <id>                 Page ID or URL

Content options (replace entire page content):
  --content <md>       Content as a string
  --content-file <f>   Read content from a file
  --stdin              Read content from stdin

Partial content options (search-and-replace):
  --replace <old>      Find <old> in the page and replace with new content
  --insert-after <a>   Insert content after the text anchor <a>

Property options (can be combined with each other):
  --title <text>       Update the page title
  --properties <json>  Update page properties (JSON object)
  --icon <emoji>       Set page icon
  --cover <url>        Set cover image

Options:
  -h, --help           Show this help

If only property options are given (no content), page content is
left unchanged.

Examples:
  notion page update abc123 --title "New Title"
  notion page update abc123 --title "New" --icon "🚀"
  notion page update abc123 --content "# Updated content"
  cat page.md | notion page update abc123 --stdin
  notion page update abc123 --replace "old text" --content "new text"
  notion page update abc123 --insert-after "## Section" --content "New text"`);
    return;
  }

  const pageId = extractId(requirePos(args, 0, "id"));
  const c = await client();

  const title = opt(args, "title");
  const replaceOld = opt(args, "replace");
  const insertAfter = opt(args, "insert-after");
  const properties = opt(args, "properties");
  const icon = opt(args, "icon");
  const cover = opt(args, "cover");
  const content = await getContent(args);

  // Handle partial content updates (update_content command with
  // content_updates array of {old_str, new_str} operations).
  if (replaceOld) {
    if (!content) {
      die(
        "--replace requires content (--content, --content-file, or --stdin)",
      );
    }
    const result = await c.call("notion-update-page", {
      page_id: pageId,
      command: "update_content",
      content_updates: [{
        old_str: replaceOld,
        new_str: markdownToNotion(content),
      }],
    });
    printResult(result);
    return;
  }
  if (insertAfter) {
    if (!content) {
      die(
        "--insert-after requires content (--content, --content-file, or --stdin)",
      );
    }
    const result = await c.call("notion-update-page", {
      page_id: pageId,
      command: "update_content",
      content_updates: [{
        old_str: insertAfter,
        new_str: insertAfter + "\n" + markdownToNotion(content),
      }],
    });
    printResult(result);
    return;
  }

  // Extract title from content if not explicitly provided.
  const contentTitle = content ? extractMarkdownTitle(content) : undefined;
  const effectiveTitle = title ?? contentTitle;

  // Handle full content replacement.
  if (content) {
    const result = await c.call("notion-update-page", {
      page_id: pageId,
      command: "replace_content",
      new_str: markdownToNotion(content),
    });
    printResult(result);
  }

  // Handle property updates (including title extracted from content).
  if (effectiveTitle || properties || icon || cover) {
    const mcpArgs: Record<string, unknown> = {
      page_id: pageId,
      command: "update_properties",
    };
    if (effectiveTitle || properties) {
      let props: Record<string, unknown> = {};
      if (properties) {
        try {
          props = JSON.parse(properties) as Record<string, unknown>;
        } catch {
          die("--properties must be valid JSON");
        }
      }
      if (effectiveTitle) props.title = effectiveTitle;
      mcpArgs.properties = props;
    }
    if (icon) mcpArgs.icon = icon;
    if (cover) mcpArgs.cover = cover;
    const result = await c.call("notion-update-page", mcpArgs);
    printResult(result);
  }

  // Nothing specified.
  if (!content && !effectiveTitle && !properties && !icon && !cover) {
    die("nothing to update: specify content or property options (see --help)");
  }
}

async function cmdPageMove(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Move pages or databases to a new parent.

Usage: notion page move <id>... --to <parent-id>

Arguments:
  <id>...              One or more page/database IDs to move

Options:
  --to <parent-id>     Target parent page or database ID (required)
  -h, --help           Show this help

Examples:
  notion page move abc123 --to def456
  notion page move abc123 def456 --to ghi789`);
    return;
  }

  const targetId = extractId(requireOpt(args, "to"));
  const pageIds = args._ as string[];
  if (pageIds.length === 0) die("provide at least one page ID to move");

  const c = await client();
  const result = await c.call("notion-move-pages", {
    page_or_database_ids: pageIds,
    new_parent: { type: "page_id", page_id: targetId },
  });
  printResult(result);
}

async function cmdPageDuplicate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Duplicate a Notion page.

Usage: notion page duplicate <id>

Arguments:
  <id>                 Page ID to duplicate

Options:
  -h, --help           Show this help`);
    return;
  }

  const pageId = extractId(requirePos(args, 0, "id"));
  const c = await client();
  const result = await c.call("notion-duplicate-page", { page_id: pageId });
  printResult(result);
}

// ─── Commands: database ──────────────────────────────────────────────

async function cmdDb(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "create":
      return await cmdDbCreate(rest);
    case "update":
      return await cmdDbUpdate(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage Notion databases.

Usage: notion db <subcommand> [options]

Subcommands:
  create               Create a new database
  update               Update a database's schema or properties

Run 'notion db <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: db ${sub}\nRun 'notion db --help' for usage.`,
      );
  }
}

async function cmdDbCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Create a new Notion database.

Usage: notion db create --parent <id> --title <title> --ddl <sql>

Options:
  --parent <id>        Parent page ID (required)
  --title <title>      Database title (required)
  --ddl <sql>          Database schema in SQL DDL syntax (required)
  -h, --help           Show this help

Examples:
  notion db create --parent abc123 --title "Tasks" \\
    --ddl "CREATE TABLE tasks (name TEXT, status STATUS, due DATE)"`);
    return;
  }

  const parentId = extractId(requireOpt(args, "parent"));
  const title = requireOpt(args, "title");
  const ddl = requireOpt(args, "ddl");

  const c = await client();
  const result = await c.call("notion-create-database", {
    parent_id: parentId,
    title,
    ddl,
  });
  printResult(result);
}

async function cmdDbUpdate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Update a database's schema or properties.

Usage: notion db update <id> [options]

Arguments:
  <id>                 Database or data source ID

Options:
  --name <name>        New database name
  --description <d>    New database description
  -h, --help           Show this help

Examples:
  notion db update abc123 --name "Project Tasks"
  notion db update abc123 --description "Tracks all team tasks"`);
    return;
  }

  const id = extractId(requirePos(args, 0, "id"));
  const mcpArgs: Record<string, unknown> = { data_source_id: id };

  const name = opt(args, "name");
  const description = opt(args, "description");
  if (name) mcpArgs.name = name;
  if (description) mcpArgs.description = description;

  const c = await client();
  const result = await c.call("notion-update-data-source", mcpArgs);
  printResult(result);
}

// ─── Commands: view ──────────────────────────────────────────────────

async function cmdView(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "create":
      return await cmdViewCreate(rest);
    case "update":
      return await cmdViewUpdate(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage database views.

Usage: notion view <subcommand> [options]

Subcommands:
  create               Create a new database view
  update               Update a view's configuration

Run 'notion view <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: view ${sub}\nRun 'notion view --help' for usage.`,
      );
  }
}

async function cmdViewCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Create a new database view.

Usage: notion view create --db <id> --ds <data-source-id> --type <type> --name <name>

Options:
  --db <id>            Database ID or URL (required)
  --ds <id>            Data source ID (required, from 'notion get <db>')
  --type <type>        View type (required): table, board, list, calendar,
                       timeline, gallery, form, chart, map, dashboard
  --name <name>        View name (required)
  --configure <dsl>    View configuration DSL (filters, sorts, etc.)
  -h, --help           Show this help

Use 'notion get <database>' to find the data source ID (shown in
<data-source url="collection://..."> tags).

Examples:
  notion view create --db abc123 --ds def456 --type board --name "Kanban"
  notion view create --db abc123 --ds def456 --type table --name "Active" \\
    --configure 'FILTER "Status" = "In Progress"; SORT BY "Due" ASC'`);
    return;
  }

  const dbId = extractId(requireOpt(args, "db"));
  const dsId = requireOpt(args, "ds");
  const type = requireOpt(args, "type");
  const name = requireOpt(args, "name");
  const configure = opt(args, "configure");

  const mcpArgs: Record<string, unknown> = {
    database_id: dbId,
    data_source_id: dsId,
    type,
    name,
  };
  if (configure) mcpArgs.configure = configure;

  const c = await client();
  const result = await c.call("notion-create-view", mcpArgs);
  printResult(result);
}

async function cmdViewUpdate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Update a database view.

Usage: notion view update <id> [options]

Arguments:
  <id>                 View ID (from 'notion get <db>')

Options:
  --name <name>        New view name
  --configure <dsl>    View configuration DSL (filters, sorts, etc.)
  -h, --help           Show this help

Examples:
  notion view update abc123 --name "Active Tasks"
  notion view update abc123 --configure 'FILTER "Status" = "Done"'
  notion view update abc123 --configure 'CLEAR FILTER; SORT BY "Created" DESC'`);
    return;
  }

  const id = requirePos(args, 0, "id");
  const mcpArgs: Record<string, unknown> = { view_id: id };

  const name = opt(args, "name");
  const configure = opt(args, "configure");

  if (name) mcpArgs.name = name;
  if (configure) mcpArgs.configure = configure;

  const c = await client();
  const result = await c.call("notion-update-view", mcpArgs);
  printResult(result);
}

// ─── Commands: comment ───────────────────────────────────────────────

async function cmdComment(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "add":
    case "create":
      return await cmdCommentAdd(rest);
    case "list":
    case "ls":
      return await cmdCommentList(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage page comments.

Usage: notion comment <subcommand> [options]

Subcommands:
  add                  Add a comment to a page
  list                 List comments on a page

Run 'notion comment <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: comment ${sub}\nRun 'notion comment --help' for usage.`,
      );
  }
}

async function cmdCommentAdd(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Add a comment to a Notion page.

Usage: notion comment add <page-id> <text>...

Arguments:
  <page-id>            Page ID to comment on
  <text>...            Comment text (remaining arguments are joined)

Options:
  -h, --help           Show this help

Examples:
  notion comment add abc123 "Looks good to me!"
  notion comment add abc123 Please review section 3`);
    return;
  }

  const positional = args._ as string[];
  if (positional.length < 2) {
    die("usage: notion comment add <page-id> <text>...");
  }

  const pageId = positional[0];
  const text = positional.slice(1).join(" ");

  const c = await client();
  const result = await c.call("notion-create-comment", {
    page_id: pageId,
    text,
  });
  printResult(result);
}

async function cmdCommentList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`List comments on a Notion page.

Usage: notion comment list <page-id>

Arguments:
  <page-id>            Page ID

Options:
  -h, --help           Show this help`);
    return;
  }

  const pageId = extractId(requirePos(args, 0, "page-id"));
  const c = await client();
  const result = await c.call("notion-get-comments", { page_id: pageId });
  printResult(result);
}

// ─── Commands: team ──────────────────────────────────────────────────

async function cmdTeam(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      return await cmdTeamList(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage workspace teams.

Usage: notion team <subcommand> [options]

Subcommands:
  list                 List workspace teams

Run 'notion team <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: team ${sub}\nRun 'notion team --help' for usage.`,
      );
  }
}

async function cmdTeamList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`List workspace teams (teamspaces).

Usage: notion team list

Options:
  -h, --help           Show this help`);
    return;
  }
  void args;

  const c = await client();
  const result = await c.call("notion-get-teams", {});
  printResult(result);
}

// ─── Commands: user ──────────────────────────────────────────────────

async function cmdUser(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      return await cmdUserList(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Look up workspace users.

Usage: notion user <subcommand> [options]

Subcommands:
  list                 List all workspace users

Run 'notion user <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: user ${sub}\nRun 'notion user --help' for usage.`,
      );
  }
}

async function cmdUserList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`List all workspace users.

Usage: notion user list

Options:
  -h, --help           Show this help`);
    return;
  }
  void args;

  const c = await client();
  const result = await c.call("notion-get-users", {});
  printResult(result);
}

// ─── Commands: tools & raw ───────────────────────────────────────────

async function cmdTools(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`List available MCP tools from the Notion server.

Usage: notion tools [options]

Options:
  --json               Output full tool definitions as JSON
  -h, --help           Show this help`);
    return;
  }

  const c = await client();
  const tools = await c.listTools();

  if (_jsonOutput) {
    console.log(JSON.stringify(tools, null, 2));
  } else {
    for (const tool of tools) {
      const desc = (tool.description || "")
        .split("\n")[0]
        .slice(0, 72);
      console.log(`  ${tool.name.padEnd(32)} ${desc}`);
    }
  }
}

async function cmdRaw(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Make a raw MCP tool call.

Usage: notion raw <tool-name> [json-arguments]

Arguments:
  <tool-name>          MCP tool name (e.g. notion-search)
  [json-arguments]     Tool arguments as a JSON string (default: {})

Options:
  -h, --help           Show this help

Examples:
  notion raw notion-search '{"query": "meeting notes"}'
  notion raw notion-get-users '{}'
  notion raw notion-fetch '{"id": "abc123"}'

Use 'notion tools' to list all available MCP tools.
Use 'notion tools --json' to see full parameter schemas.`);
    return;
  }

  const positional = args._ as string[];
  const toolName = positional[0];
  if (!toolName) die("usage: notion raw <tool-name> [json-arguments]");

  let toolArgs: Record<string, unknown> = {};
  if (positional[1]) {
    try {
      toolArgs = JSON.parse(positional[1]);
    } catch {
      die("invalid JSON arguments");
    }
  }

  const c = await client();
  const result = await c.call(toolName, toolArgs);
  printResult(result);
}

// ─── Commands: auth ──────────────────────────────────────────────────

async function cmdAuth(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "login":
      return await cmdAuthLogin(rest);
    case "logout":
      return await cmdAuthLogout(rest);
    case "status":
      return await cmdAuthStatus(rest);
    case "--help":
    case "-h":
    case undefined:
      console.log(`Manage authentication.

Usage: notion auth <subcommand>

Subcommands:
  login                Authenticate with Notion (opens browser)
  logout               Remove stored credentials
  status               Show current authentication status

Run 'notion auth <subcommand> --help' for details.`);
      return;
    default:
      die(
        `unknown subcommand: auth ${sub}\nRun 'notion auth --help' for usage.`,
      );
  }
}

async function cmdAuthLogin(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Authenticate with Notion via OAuth.

Opens a browser window for you to authorize access to your
Notion workspace. Tokens are saved to ${getTokenPath()}.

Usage: notion auth login

Options:
  -h, --help           Show this help`);
    return;
  }
  void args;
  await login();
}

async function cmdAuthLogout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Remove stored Notion credentials.

Usage: notion auth logout

Options:
  -h, --help           Show this help`);
    return;
  }
  void args;
  await logout();
}

async function cmdAuthStatus(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (wantHelp(args)) {
    console.log(`Show current authentication status.

Usage: notion auth status

Options:
  -h, --help           Show this help`);
    return;
  }
  void args;

  const path = getTokenPath();
  try {
    const tokens = JSON.parse(await Deno.readTextFile(path));
    const expiresAt = new Date(tokens.expires_at * 1000);
    const now = new Date();
    const expired = expiresAt < now;
    console.log(`Logged in`);
    console.log(`  Token file: ${path}`);
    console.log(
      `  Token expires: ${expiresAt.toLocaleString()}${
        expired ? " (expired, will refresh on next use)" : ""
      }`,
    );
  } catch {
    console.log(`Not logged in`);
    console.log(`  No token file at ${path}`);
    console.log(`  Run 'notion auth login' to authenticate.`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

const HELP = `Notion CLI - Access your Notion workspace from the command line.

Usage: notion <command> [options]

Commands:
  auth                 Log in or out of Notion
  search               Search pages and databases
  get                  Fetch a page or database by ID or URL
  page                 Create, update, move, or duplicate pages
  db                   Create, update, or query databases
  view                 Create or update database views
  comment              Add or list comments on pages
  team                 List workspace teams
  user                 List or look up workspace users
  tools                List available MCP tools
  raw                  Make a raw MCP tool call

Options:
  --json               Output raw JSON instead of readable text
  -h, --help           Show this help
  -v, --version        Show version

Run 'notion <command> --help' for more information on a command.`;

async function main(): Promise<void> {
  // Extract global --json flag before routing.
  const argv = Deno.args.filter((a) => {
    if (a === "--json") {
      _jsonOutput = true;
      return false;
    }
    return true;
  });
  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    switch (cmd) {
      case "auth":
        return await cmdAuth(rest);
      case "search":
        return await cmdSearch(rest);
      case "get":
      case "fetch":
        return await cmdGet(rest);
      case "page":
        return await cmdPage(rest);
      case "db":
      case "database":
        return await cmdDb(rest);
      case "view":
        return await cmdView(rest);
      case "comment":
        return await cmdComment(rest);
      case "team":
        return await cmdTeam(rest);
      case "user":
        return await cmdUser(rest);
      case "tools":
        return await cmdTools(rest);
      case "raw":
        return await cmdRaw(rest);
      case "--version":
      case "-v":
        console.log(`notion-cli ${VERSION}`);
        return;
      case "--help":
      case "-h":
      case undefined:
        console.log(HELP);
        return;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(`Run 'notion --help' for usage.`);
        Deno.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    Deno.exit(1);
  }
}

main();

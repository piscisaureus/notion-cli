/**
 * Tests for Notion MCP <-> Markdown bidirectional transforms.
 *
 * ## Notion MCP backend behaviors (discovered empirically)
 *
 * These are non-obvious behaviors of Notion's MCP server that our
 * transforms must account for:
 *
 * ### Escaping (output format vs input format asymmetry)
 *
 * - `\$` in MCP output means literal `$`. The server DOES NOT use
 *   `\$` on input; raw `$` is accepted. So we unescape on export
 *   and re-escape on import.
 *
 * - `\*` in MCP output means literal `*`. However, the server does
 *   NOT interpret `\*` as an escape on input -- it stores the
 *   backslash literally. So we unescape `\*` -> `*` on export but
 *   do NOT re-escape on import.
 *
 * - `$` inside code fences and inline code spans is NOT escaped in
 *   MCP output. Our transforms must skip escaping inside these.
 *
 * - `<br>` is ALWAYS interpreted as a line break by the server,
 *   even inside inline code. There is no known escape that prevents
 *   this. (`\<br\>` shows literally with backslashes visible.)
 *
 * ### Why `$` is special
 *
 * Notion uses `$...$` as inline equation (LaTeX) delimiters. This is
 * why `$` needs escaping in the MCP format -- `$10` would be parsed
 * as the start of an equation, not a dollar amount. The Notion web
 * client's own markdown serializer emits `$` only when an equation
 * annotation is present on the text; it does NOT escape bare `$` in
 * body text. The MCP server adds the `\$` escaping itself.
 *
 * ### Backslash handling
 *
 * The Notion web client's markdown paste handler (Cmd+Shift+V)
 * doubles all backslashes before passing to markdown-it:
 *   `text.replace(/\\/g, "\\\\")`
 * This means `\*` in pasted markdown becomes `\\*`, which markdown-it
 * renders as a literal backslash followed by `*`. The MCP server
 * likely uses the same markdown-it pipeline for `replace_content`,
 * which explains why:
 *   - `\$` sent via MCP input is stored as literal `\$` (backslash
 *     visible), not as an escaped dollar sign.
 *   - `\*` sent via MCP input is stored as literal `\*`, not as an
 *     escaped asterisk.
 * Our workaround: unescape on export, re-escape `$` (but not `*`)
 * on import. The server handles raw `$` correctly (escapes it
 * internally), and raw `*` is interpreted as markdown formatting
 * which is the desired behavior.
 *
 * ### Escaping edge case: `\*` adjacent to bold markers
 *
 * - MCP output: `**text-\***` (bold text ending with literal `*`)
 * - After our unescape: `**text-***`
 * - Server re-parses: `**text-**` + `*` (splits bold from asterisk)
 * - Visual result in Notion is correct but internal structure changes
 * - Stabilizes after one round-trip
 *
 * ### Block structure
 *
 * - In MCP format, each block is on a single line separated by `\n`.
 * - `<empty-block/>` represents visible empty space in Notion.
 * - Code blocks inside list items have tab-indented fences but
 *   unindented content. We must indent content on export (for
 *   editor/prettier compatibility) and strip on import.
 *
 * ### Notion client markdown format vs MCP format
 *
 * The Notion web client (clipboard copy) and MCP server produce
 * different markdown for some block types:
 *   - Callouts: client uses `<aside>`, MCP uses `<callout>` with
 *     icon/color attributes.
 *   - Links: client deduplicates `[url](url)` -> bare `url`.
 *   - Code languages: MCP expands aliases (`tsx` -> `typescript`).
 *   - List indentation: client uses 4 spaces, MCP uses tabs.
 *   - Special characters: client does NOT escape `$`, `*`, etc. in
 *     body text (formatting is annotation-driven). MCP does escape.
 * Our transforms target the MCP format, not the client format.
 *
 * ### Backslash escapes supported by the MCP server on input
 *
 * Tested empirically by sending `\X` and checking what Notion stored:
 *   - `\*` -> literal `*` (works, stored as `\*` in MCP output)
 *   - `\#` -> literal `#` (works, but backslash is consumed -- NOT
 *     in MCP output)
 *   - `\-` -> literal `-` (same: consumed, not in output)
 *   - `\>` -> literal `>` (stored as `\>` in MCP output)
 *   - `\[`, `\]` -> literal brackets (stored as `\[`, `\]`)
 *   - `\|` -> literal pipe (stored as `\|`)
 *   - `\~` -> literal tilde (stored as `\~`)
 *   - `\_` -> does NOT prevent italic (underscore italic still works)
 *   - `\\` -> single `\` (stored as `\\\\` in MCP output -- quad!)
 *   - `\$` on input -> stored as literal `\$` (backslash visible),
 *     NOT as an escaped dollar. Our CLI sends raw `$` instead.
 *
 * ### Equations
 *
 * Raw `$...$` on input creates inline equations (LaTeX rendered).
 * `$$..$$` also creates inline equations (NOT block equations).
 * `$10` alone does NOT trigger equation mode (no closing `$`).
 * Equations in MCP output appear as: `$\`latex content\`$`
 *
 * ### Numbered lists
 *
 * The server auto-renumbers: `1. 1. 1.` becomes `1. 2. 3.` and
 * `5. 6. 7.` continues from the previous list (`4. 5. 6.`).
 *
 * ### Tables
 *
 * Markdown pipe tables (`| a | b |`) are converted to Notion's
 * `<table>` / `<tr>` / `<td>` HTML-like format in MCP output.
 * They do NOT round-trip as pipe syntax.
 *
 * ### Tags recognized by MCP server
 *
 * Valid: `<callout>`, `<video>`, `<image>`, `<database>`,
 *   `<table>`, `<tr>`, `<td>`, `<br>`, `<empty-block/>`,
 *   `<span>` (with discussion-urls), `<table_of_contents>`,
 *   `<mention-page>`
 * NOT valid (stored as literal text with escaped brackets):
 *   `<toggle>`, `<quote>`, `<aside>`
 *
 * ### Deep nesting
 *
 * Nesting uses tab indentation in MCP format:
 *   Level 1: `1. item`
 *   Level 2: `\t- sub-item`
 *   Level 3: `\t\t- sub-sub-item`
 *
 * ### Caret escaping
 *
 * The `^` character is escaped by the server (stored as `\^`).
 * This is likely because `^` has meaning in superscript context.
 *
 * ### Content that doesn't survive round-trip (server-side)
 *
 * - Trailing whitespace in table cells is stripped by the server.
 * - Signed S3 image URLs expire between fetch and re-upload.
 * - `<empty-block/>` may be lost if editor collapses blank lines.
 * - Whitespace-only lines are stripped by the server.
 * - Double-backtick inline code (`` ``code`` ``) may be mangled.
 * - Tab indentation outside list items is stripped.
 * - `<br>` inside inline code is interpreted as line break (no
 *   known workaround).
 */

import { assertEquals } from "@std/assert";
import { extractMarkdownTitle, markdownToNotion } from "./mcp.ts";

// We need notionToMarkdown but it's not exported. Test it indirectly
// through the round-trip or export a test helper. For now, we'll test
// the exported functions and do round-trip tests through markdownToNotion.
//
// To test notionToMarkdown, we use a small wrapper that calls it via
// the module internals. Since it's not exported, we test its behavior
// indirectly through parseFetchResult or by testing specific input/output
// pairs through markdownToNotion (which is the reverse).

// ─── Helper ──────────────────────────────────────────────────────────

// For tests that need notionToMarkdown, we simulate MCP output and
// use parseFetchResult. But for most unit tests, we focus on
// markdownToNotion since that's where most bugs occur (user input).

// ─── extractMarkdownTitle ────────────────────────────────────────────

Deno.test("extractMarkdownTitle: basic heading", () => {
  assertEquals(extractMarkdownTitle("# My Title\n\nContent"), "My Title");
});

Deno.test("extractMarkdownTitle: with leading URL", () => {
  assertEquals(
    extractMarkdownTitle(
      "https://www.notion.so/abc123\n\n# My Title\n\nContent",
    ),
    "My Title",
  );
});

Deno.test("extractMarkdownTitle: no heading", () => {
  assertEquals(extractMarkdownTitle("Just some text"), undefined);
});

Deno.test("extractMarkdownTitle: heading with emoji", () => {
  assertEquals(
    extractMarkdownTitle("# 📓 KV Runbooks\n\nText"),
    "📓 KV Runbooks",
  );
});

Deno.test("extractMarkdownTitle: heading with trailing whitespace", () => {
  assertEquals(extractMarkdownTitle("# Title  \n\nText"), "Title");
});

// ─── markdownToNotion: title stripping ───────────────────────────────

Deno.test("title stripping: removes # heading", () => {
  const result = markdownToNotion("# My Title\n\nSome content");
  assertEquals(result, "Some content");
});

Deno.test("title stripping: strips leading URL then title", () => {
  const result = markdownToNotion(
    "https://www.notion.so/abc123\n\n# My Title\n\nSome content",
  );
  assertEquals(result, "Some content");
});

Deno.test("title stripping: no title present", () => {
  const result = markdownToNotion("Some content\n\nMore content");
  assertEquals(result, "Some content\nMore content");
});

Deno.test("title stripping: only URL, no title", () => {
  const result = markdownToNotion(
    "https://www.notion.so/abc123\n\nSome content",
  );
  assertEquals(result, "Some content");
});

Deno.test(
  "title stripping: does not duplicate title on round-trip (issue #1)",
  () => {
    // Simulate: notion get output -> edit -> notion page update
    const notionGetOutput = "# My Page Title\n\n## Section\n\nContent here";
    const result = markdownToNotion(notionGetOutput);
    // Title should be stripped; body should not contain # My Page Title
    assertEquals(result.includes("# My Page Title"), false);
    assertEquals(result.includes("## Section"), true);
  },
);

// ─── markdownToNotion: dollar sign escaping ──────────────────────────

Deno.test("dollar escaping: $ in regular text is escaped", () => {
  const result = markdownToNotion("# T\n\nThe cost is $10");
  assertEquals(result, "The cost is \\$10");
});

Deno.test(
  "dollar escaping: $ inside code fence is NOT escaped",
  () => {
    const result = markdownToNotion(
      "# T\n\n```bash\n$ export FOO=bar\n$ echo $FOO\n```",
    );
    assertEquals(
      result,
      "```bash\n$ export FOO=bar\n$ echo $FOO\n```",
    );
  },
);

Deno.test(
  "dollar escaping: $ inside inline code is NOT escaped",
  () => {
    const result = markdownToNotion("# T\n\nRun `$HOME/bin/foo`");
    assertEquals(result, "Run `$HOME/bin/foo`");
  },
);

Deno.test(
  "dollar escaping: $ in text next to inline code is escaped",
  () => {
    const result = markdownToNotion("# T\n\nCosts $5 to run `cmd`");
    assertEquals(result, "Costs \\$5 to run `cmd`");
  },
);

Deno.test("dollar escaping: $ with double backtick inline code", () => {
  const result = markdownToNotion("# T\n\nUse ``$var`` in $context");
  assertEquals(result, "Use ``$var`` in \\$context");
});

// ─── markdownToNotion: empty-block round-trip ────────────────────────

Deno.test("empty-block: double blank lines become <empty-block/>", () => {
  const result = markdownToNotion("# T\n\nParagraph A\n\n\nParagraph B");
  assertEquals(result, "Paragraph A\n<empty-block/>\nParagraph B");
});

Deno.test("empty-block: single blank line is normal separator", () => {
  const result = markdownToNotion("# T\n\nParagraph A\n\nParagraph B");
  assertEquals(result, "Paragraph A\nParagraph B");
});

Deno.test("empty-block: triple blank lines become two <empty-block/>", () => {
  const result = markdownToNotion("# T\n\nA\n\n\n\nB");
  assertEquals(result, "A\n<empty-block/>\n<empty-block/>\nB");
});

Deno.test(
  "empty-block: blank lines inside code fences are preserved",
  () => {
    const result = markdownToNotion(
      "# T\n\n```\nline1\n\nline2\n\n\nline3\n```",
    );
    assertEquals(result, "```\nline1\n\nline2\n\n\nline3\n```");
  },
);

// ─── markdownToNotion: block separation ──────────────────────────────

Deno.test(
  "block separation: blank lines between paragraphs are collapsed",
  () => {
    const result = markdownToNotion("# T\n\nA\n\nB\n\nC");
    assertEquals(result, "A\nB\nC");
  },
);

Deno.test("block separation: list items stay together", () => {
  const result = markdownToNotion("# T\n\n- a\n- b\n- c");
  assertEquals(result, "- a\n- b\n- c");
});

Deno.test(
  "block separation: numbered list items stay together",
  () => {
    const result = markdownToNotion("# T\n\n1. a\n2. b\n3. c");
    assertEquals(result, "1. a\n2. b\n3. c");
  },
);

Deno.test(
  "block separation: blank line between heading and paragraph",
  () => {
    const result = markdownToNotion("# T\n\n## Heading\n\nParagraph");
    assertEquals(result, "## Heading\nParagraph");
  },
);

// ─── markdownToNotion: paragraph unwrapping ──────────────────────────

Deno.test("unwrapping: soft-wrapped paragraph is joined", () => {
  const result = markdownToNotion(
    "# T\n\nThis is a long paragraph that\nhas been soft-wrapped by the\neditor at 80 characters.",
  );
  assertEquals(
    result,
    "This is a long paragraph that has been soft-wrapped by the editor at 80 characters.",
  );
});

Deno.test("unwrapping: two spaces before newline becomes <br>", () => {
  const result = markdownToNotion("# T\n\nLine one  \nLine two");
  assertEquals(result, "Line one<br>Line two");
});

Deno.test("unwrapping: headings are not joined", () => {
  const result = markdownToNotion("# T\n\n## Heading\n\nParagraph");
  assertEquals(result, "## Heading\nParagraph");
});

Deno.test("unwrapping: list items are not joined with each other", () => {
  const result = markdownToNotion("# T\n\n- item one\n- item two");
  assertEquals(result, "- item one\n- item two");
});

Deno.test(
  "unwrapping: indented continuation under list item IS joined",
  () => {
    const result = markdownToNotion(
      "# T\n\n- Access to the **database** (via\n  `proxy`).",
    );
    assertEquals(result, "- Access to the **database** (via `proxy`).");
  },
);

Deno.test(
  "unwrapping: indented sub-list under list item is NOT joined (issue #6)",
  () => {
    const result = markdownToNotion(
      "# T\n\n1. Parent item:\n   - Sub-item A\n   - Sub-item B",
    );
    assertEquals(result, "1. Parent item:\n   - Sub-item A\n   - Sub-item B");
  },
);

Deno.test(
  "unwrapping: nested numbered sub-list is NOT joined",
  () => {
    const result = markdownToNotion(
      "# T\n\n1. Parent:\n   1. Sub one\n   2. Sub two",
    );
    assertEquals(result, "1. Parent:\n   1. Sub one\n   2. Sub two");
  },
);

Deno.test("unwrapping: code fences are not unwrapped", () => {
  const result = markdownToNotion(
    "# T\n\n```\nline one\nline two\nline three\n```",
  );
  assertEquals(result, "```\nline one\nline two\nline three\n```");
});

Deno.test(
  "unwrapping: HTML-like tags start new blocks",
  () => {
    const result = markdownToNotion(
      '# T\n\n<callout icon="!" color="red">\n\tSome text\n</callout>',
    );
    assertEquals(
      result,
      '<callout icon="!" color="red">\n\tSome text\n</callout>',
    );
  },
);

// ─── markdownToNotion: code fence indentation ────────────────────────

Deno.test(
  "code fence indent: tab-indented fence has content stripped",
  () => {
    const result = markdownToNotion(
      "# T\n\n\t```typescript\n\t$ export FOO=bar\n\t$ echo hi\n\t```",
    );
    assertEquals(
      result,
      "\t```typescript\n$ export FOO=bar\n$ echo hi\n\t```",
    );
  },
);

Deno.test(
  "code fence indent: space-indented fence (from prettier) has content stripped",
  () => {
    const result = markdownToNotion(
      "# T\n\n   ```typescript\n   $ export FOO=bar\n   $ echo hi\n   ```",
    );
    assertEquals(
      result,
      "   ```typescript\n$ export FOO=bar\n$ echo hi\n   ```",
    );
  },
);

Deno.test(
  "code fence indent: top-level fence content is unchanged",
  () => {
    const result = markdownToNotion(
      "# T\n\n```bash\n$ echo hello\n```",
    );
    assertEquals(result, "```bash\n$ echo hello\n```");
  },
);

Deno.test(
  "code fence indent: blank lines inside indented fence are preserved",
  () => {
    const result = markdownToNotion(
      "# T\n\n\t```\n\tline1\n\t\n\tline2\n\t```",
    );
    assertEquals(result, "\t```\nline1\n\nline2\n\t```");
  },
);

// ─── markdownToNotion: inline code handling ──────────────────────────

Deno.test("inline code: $ not escaped inside backticks", () => {
  const result = markdownToNotion("# T\n\nRun `$HOME/bin/foo` now");
  assertEquals(result, "Run `$HOME/bin/foo` now");
});

Deno.test(
  "inline code: $ escaped in text surrounding backticks",
  () => {
    const result = markdownToNotion("# T\n\n$5 for `cmd` or $10");
    assertEquals(result, "\\$5 for `cmd` or \\$10");
  },
);

Deno.test("inline code: double backtick spans", () => {
  const result = markdownToNotion("# T\n\nUse ``$var`` costs $1");
  assertEquals(result, "Use ``$var`` costs \\$1");
});

Deno.test(
  "inline code: unmatched backtick is treated as text",
  () => {
    const result = markdownToNotion("# T\n\nCost is $5 per `unit");
    // Unmatched backtick: the ` is literal text, $ before and after
    // it are both escaped since there's no closing backtick.
    assertEquals(result, "Cost is \\$5 per `unit");
  },
);

// ─── markdownToNotion: <br> tag handling ─────────────────────────────

Deno.test("<br> outside inline code passes through", () => {
  const result = markdownToNotion("# T\n\nLine one<br>Line two");
  assertEquals(result, "Line one<br>Line two");
});

// ─── markdownToNotion: Notion-specific tags pass through ─────────────

Deno.test("video tags pass through", () => {
  const input = '# T\n\n<video src="file://encoded"></video>';
  const result = markdownToNotion(input);
  assertEquals(result, '<video src="file://encoded"></video>');
});

Deno.test("callout tags pass through", () => {
  const input = '# T\n\n<callout icon="!" color="gray_bg">\n\tText\n</callout>';
  const result = markdownToNotion(input);
  assertEquals(
    result,
    '<callout icon="!" color="gray_bg">\n\tText\n</callout>',
  );
});

Deno.test("span discussion tags pass through", () => {
  const input = '# T\n\n<span discussion-urls="discussion://abc">Text</span>';
  const result = markdownToNotion(input);
  assertEquals(
    result,
    '<span discussion-urls="discussion://abc">Text</span>',
  );
});

Deno.test("database reference tags pass through", () => {
  const input =
    '# T\n\n<database url="https://notion.so/abc" inline="true">DB</database>';
  const result = markdownToNotion(input);
  assertEquals(
    result,
    '<database url="https://notion.so/abc" inline="true">DB</database>',
  );
});

// ─── markdownToNotion: comprehensive round-trip scenarios ────────────

Deno.test("round-trip: simple page", () => {
  const mcp = "## Section\nSome text here.\n## Another\nMore text.";
  // notionToMarkdown would produce:
  const md =
    "# Title\n\n## Section\n\nSome text here.\n\n## Another\n\nMore text.";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test("round-trip: page with code block", () => {
  const mcp = "Text before\n```bash\n$ echo $HOME\nfoo\n```\nText after";
  const md =
    "# T\n\nText before\n\n```bash\n$ echo $HOME\nfoo\n```\n\nText after";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test("round-trip: page with empty blocks", () => {
  const mcp = "A\n<empty-block/>\nB";
  const md = "# T\n\nA\n\n\nB";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test("round-trip: page with list and nested sub-items", () => {
  const mcp = "1. Parent:\n   - Sub A\n   - Sub B\n2. Next item";
  const md = "# T\n\n1. Parent:\n   - Sub A\n   - Sub B\n2. Next item";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test("round-trip: page with inline code and dollar signs", () => {
  const mcp = "Run `$HOME/script.sh` for \\$5";
  const md = "# T\n\nRun `$HOME/script.sh` for $5";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test("round-trip: page with indented code block in list", () => {
  const mcp = "1. Step one:\n\t```bash\n$ echo hello\n\t```\n2. Step two";
  const md =
    "# T\n\n1. Step one:\n\n\t```bash\n\t$ echo hello\n\t```\n\n2. Step two";
  const result = markdownToNotion(md);
  assertEquals(result, mcp);
});

Deno.test(
  "round-trip: page with soft-wrapped paragraphs",
  () => {
    const mcp =
      "This is a very long paragraph that was originally on one line but the editor wrapped it.";
    const md =
      "# T\n\nThis is a very long paragraph that was originally\non one line but the editor wrapped it.";
    const result = markdownToNotion(md);
    assertEquals(result, mcp);
  },
);

Deno.test(
  "round-trip: page with hard line breaks (two trailing spaces)",
  () => {
    const mcp = "Line one<br>Line two<br>Line three";
    const md = "# T\n\nLine one  \nLine two  \nLine three";
    const result = markdownToNotion(md);
    assertEquals(result, mcp);
  },
);

Deno.test(
  "round-trip: list item with wrapped continuation",
  () => {
    const mcp =
      "- Access to the **classic postgres database** (GCP Cloud SQL via `cloud_sql_proxy`).";
    const md =
      "# T\n\n- Access to the **classic postgres database** (GCP Cloud SQL via\n  `cloud_sql_proxy`).";
    const result = markdownToNotion(md);
    assertEquals(result, mcp);
  },
);

// ─── markdownToNotion: edge cases ────────────────────────────────────

Deno.test("edge case: empty input", () => {
  assertEquals(markdownToNotion(""), "");
});

Deno.test("edge case: title only", () => {
  assertEquals(markdownToNotion("# Title\n"), "");
});

Deno.test("edge case: title with trailing newline", () => {
  assertEquals(markdownToNotion("# Title\n"), "");
});

Deno.test("edge case: content with no title", () => {
  assertEquals(markdownToNotion("Just text"), "Just text");
});

Deno.test(
  "edge case: URL line followed by content without title",
  () => {
    assertEquals(
      markdownToNotion("https://notion.so/abc\n\nJust text"),
      "Just text",
    );
  },
);

Deno.test(
  "edge case: multiple # headings, only first is title",
  () => {
    const result = markdownToNotion("# Title\n\n# Not stripped\n\nText");
    assertEquals(result, "# Not stripped\nText");
  },
);

Deno.test(
  "edge case: blockquote is not joined with previous line",
  () => {
    const result = markdownToNotion("# T\n\nSome text\n\n> A quote");
    assertEquals(result, "Some text\n> A quote");
  },
);

Deno.test(
  "edge case: indented blockquote is not joined",
  () => {
    const result = markdownToNotion("# T\n\nSome text\n\n  > Indented quote");
    assertEquals(result, "Some text\n  > Indented quote");
  },
);

Deno.test(
  "edge case: table rows are not joined",
  () => {
    const result = markdownToNotion(
      "# T\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    );
    assertEquals(result, "| a | b |\n|---|---|\n| 1 | 2 |");
  },
);

// ─── Findings from edge case test pages ──────────────────────────────
// These tests document behaviors observed by uploading content to Notion
// and re-fetching the raw MCP output.

Deno.test(
  "deep nesting: three levels use multiple tabs",
  () => {
    // MCP output uses \t per nesting level. Our markdownToNotion should
    // preserve indented sub-items.
    const result = markdownToNotion(
      "# T\n\n1. Level 1\n   - Level 2a\n      - Level 3a\n      - Level 3b\n   - Level 2b\n2. Back to level 1",
    );
    assertEquals(
      result,
      "1. Level 1\n   - Level 2a\n      - Level 3a\n      - Level 3b\n   - Level 2b\n2. Back to level 1",
    );
  },
);

Deno.test(
  "checkboxes: to-do items are preserved",
  () => {
    const result = markdownToNotion(
      "# T\n\n- [ ] Unchecked\n- [x] Checked\n- [ ] Another",
    );
    assertEquals(result, "- [ ] Unchecked\n- [x] Checked\n- [ ] Another");
  },
);

Deno.test(
  "horizontal rules: --- passes through",
  () => {
    const result = markdownToNotion("# T\n\nAbove\n\n---\n\nBelow");
    assertEquals(result, "Above\n---\nBelow");
  },
);

Deno.test(
  "horizontal rules: *** passes through",
  () => {
    const result = markdownToNotion("# T\n\nAbove\n\n***\n\nBelow");
    assertEquals(result, "Above\n***\nBelow");
  },
);

Deno.test(
  "images: markdown image syntax preserved",
  () => {
    const result = markdownToNotion(
      "# T\n\n![Alt text](https://example.com/img.png)",
    );
    assertEquals(result, "![Alt text](https://example.com/img.png)");
  },
);

Deno.test(
  "consecutive code blocks stay separate",
  () => {
    const result = markdownToNotion(
      "# T\n\n```javascript\nconst a = 1;\n```\n\n```python\nb = 2\n```",
    );
    assertEquals(
      result,
      "```javascript\nconst a = 1;\n```\n```python\nb = 2\n```",
    );
  },
);

Deno.test(
  "inline code at different positions in a line",
  () => {
    const r1 = markdownToNotion("# T\n\n`code at start` of line");
    assertEquals(r1, "`code at start` of line");

    const r2 = markdownToNotion("# T\n\nEnd with `code at end`");
    assertEquals(r2, "End with `code at end`");

    const r3 = markdownToNotion("# T\n\n`entire line is code`");
    assertEquals(r3, "`entire line is code`");
  },
);

Deno.test(
  "links with special characters in URL",
  () => {
    const result = markdownToNotion(
      "# T\n\n[Link](https://example.com/path?cost=$10)",
    );
    // $ inside a markdown link URL should still be escaped
    assertEquals(
      result,
      "[Link](https://example.com/path?cost=\\$10)",
    );
  },
);

Deno.test(
  "links with parens in URL (wikipedia style)",
  () => {
    const result = markdownToNotion(
      "# T\n\n[Link](https://en.wikipedia.org/wiki/Foo_(bar))",
    );
    assertEquals(
      result,
      "[Link](https://en.wikipedia.org/wiki/Foo_(bar))",
    );
  },
);

Deno.test(
  "mixed block types without blank lines",
  () => {
    const result = markdownToNotion(
      "# T\n\nParagraph before list:\n- item one\n- item two\nParagraph after list.",
    );
    // List items should not be joined with surrounding paragraphs
    assertEquals(
      result,
      "Paragraph before list:\n- item one\n- item two\nParagraph after list.",
    );
  },
);

Deno.test(
  "dollar in equation context is escaped to prevent LaTeX",
  () => {
    // Raw $...$ creates equations in Notion. Our escaping prevents this.
    const result = markdownToNotion("# T\n\n$x^2 + y^2 = z^2$");
    assertEquals(result, "\\$x^2 + y^2 = z^2\\$");
  },
);

Deno.test(
  "multiple dollar signs all escaped",
  () => {
    const result = markdownToNotion("# T\n\n$foo and $bar");
    assertEquals(result, "\\$foo and \\$bar");
  },
);

Deno.test(
  "dollar at start of line is escaped",
  () => {
    const result = markdownToNotion("# T\n\n$PATH is important");
    assertEquals(result, "\\$PATH is important");
  },
);

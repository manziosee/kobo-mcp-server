# kobo-mcp-server

MCP server exposing KoboToolbox survey data (forms, submissions, summaries, stats) to AI agents like Claude.

## Tools

- `list_forms` — list all forms visible to the API token, with deployment status and submission counts.
- `get_form_summary` — metadata for one form: dates, submission count, and question list (name/type/label/required).
- `get_submissions` — paginated submissions for a form, with an optional Mongo-style `query` filter, `sort`, and `fields` selection.
- `get_submission_stats` — total count, date range, and a trend bucketed by day/week/month.
- `flag_incomplete_submissions` — submissions missing an answer for a required question (top-level fields only, not repeat-group questions).
- `export_submissions_csv` — submissions as CSV text for the agent to save or hand off to another tool.

## Setup

1. Get an API token: KoboToolbox account → **Account Settings → Security → API Token**.
2. Copy `.env.example` to `.env` and fill in `KOBO_API_TOKEN` (and `KOBO_BASE_URL` if self-hosted or on the EU server).
3. Install, build, and test:

   ```sh
   npm install
   npm run build
   npm test
   ```

4. Run directly for a smoke test:

   ```sh
   npm start
   ```

   Or inspect it interactively:

   ```sh
   npm run inspector
   ```

## Use with Claude Code

This project ships a project-scoped [.mcp.json](.mcp.json), so once you've run `npm install && npm run build` and populated `.env`, Claude Code picks up the `kobo` server automatically for this folder — no extra config needed.

## Use with Claude Desktop

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kobo": {
      "command": "node",
      "args": ["d:/MCP/build/index.js"],
      "env": {
        "KOBO_API_TOKEN": "your-token-here",
        "KOBO_BASE_URL": "https://kf.kobotoolbox.org"
      }
    }
  }
}
```

## Development

- `npm run typecheck` — type-checks source and tests (the production `build` excludes `*.test.ts`).
- `npm test` — runs the unit test suite (Node's built-in test runner, `fetch` mocked — no live Kobo account needed).
- `npm run build` — compiles to `build/`.

## Notes

- Read-only by design: no tool creates, edits, or deletes forms or submissions.
- Submission payloads can contain personal or sensitive data (names, GPS, health/protection info) — this server doesn't log response bodies, and `get_submissions`/`export_submissions_csv` support `fields` to request only what's needed.
- `get_submissions` caps `limit` at 100 per call; page through with `start` for larger pulls. `get_submission_stats`, `flag_incomplete_submissions`, and `export_submissions_csv` scan internally up to a `maxRows` cap (default varies by tool, hard max 2000) to avoid unbounded API usage.
- Requests retry automatically on transient failures (429/502/503/504 or network errors), up to 2 retries with backoff; 4xx errors (bad token, missing form) fail immediately and are returned as a tool error rather than crashing the server. Verified live against a real KoboToolbox server with an invalid token.

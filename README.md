# kobo-mcp-server

MCP server exposing KoboToolbox survey data (forms, submissions, media, geodata, QA checks) to AI agents like Claude.

## Tools

- `list_forms` — list all forms visible to the API token, with deployment status and submission counts.
- `get_form_summary` — metadata for one form: dates, submission count, and question list (name, full path, type, label, required, enclosing repeat group). Cached in memory for a few minutes per form.
- `get_submissions` — paginated submissions for a form, with an optional Mongo-style `query` filter, `sort`, and `fields` selection.
- `get_submission_stats` — total count, date range, and a trend bucketed by day/week/month.
- `flag_incomplete_submissions` — submissions missing an answer for a required question, including questions inside repeat groups (checked per repeat instance, best-effort — see Notes).
- `get_submission_attachments` — list photo/audio/video/file attachments for one submission, with download URLs.
- `get_geo_submissions` — submissions with a geopoint answer, as GeoJSON (default) or plain JSON, with optional bounding-box filtering.
- `get_validation_summary` — breakdown of submissions by Kobo's manual validation status (Approved / Not Approved / On Hold / not reviewed).
- `find_duplicate_submissions` — submissions sharing the same value for a given field (e.g. a phone number or ID question).
- `export_submissions_csv` — submissions as CSV text for the agent to save or hand off to another tool.

## Resources & prompts

- Resource template `kobo://forms/{uid}` — browse a form's summary (same data as `get_form_summary`) as an MCP resource.
- Prompt `weekly_submission_digest` — given a form uid, chains `get_submission_stats` + `flag_incomplete_submissions` + `get_validation_summary` into a short activity report.

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
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, test, and build on every push/PR to `main`.

## Scope

- Read-only by design: no tool creates, edits, or deletes forms or submissions.
- KoboToolbox only. ODK Central uses a different auth model (session login, no static API token) and a different submissions API (OData-based); it's deliberately out of scope for this server rather than bolted on unverified.

## Notes

- Submission payloads (and attachments) can contain personal or sensitive data (names, GPS, photos, health/protection info) — this server doesn't log response bodies, and `get_submissions`/`export_submissions_csv`/`get_geo_submissions` support field selection to request only what's needed.
- `get_submissions` caps `limit` at 100 per call; page through with `start` for larger pulls. The scanning tools (`get_submission_stats`, `flag_incomplete_submissions`, `get_geo_submissions`, `get_validation_summary`, `find_duplicate_submissions`, `export_submissions_csv`) page internally up to a `maxRows` cap (default varies by tool, hard max 2000) to avoid unbounded API usage.
- Requests retry automatically on transient failures (429/502/503/504 or network errors), up to 2 retries with backoff; 4xx errors (bad token, missing form) fail immediately and are returned as a tool error rather than crashing the server. Verified live against a real KoboToolbox server with an invalid token.
- `flag_incomplete_submissions`'s repeat-group handling is best-effort: it matches submission JSON keys by the question's full path first, falling back to the bare question name, since Kobo's export shape for nested repeats isn't fully documented and hasn't been verified against a live account with repeat groups.
- Not yet verified against a real KoboToolbox account with actual form data — verified so far: auth/error paths (401/404) against the live API, and all response-shape assumptions against unit tests with mocked responses.

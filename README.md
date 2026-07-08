# kobo-mcp-server

MCP server exposing KoboToolbox survey data (forms, submissions, media, geodata, QA checks) to AI agents like Claude.

## Tools

- `list_forms` — list all forms visible to the API token, with deployment status and submission counts.
- `get_form_summary` — metadata for one form: dates, submission count, and question list (name, full path, type, label, required, enclosing repeat group). Cached in memory for a few minutes per form.
- `get_submissions` — paginated submissions for a form, with an optional Mongo-style `query` filter, `sort`, and `fields` selection. By default, `select_one`/`select_multiple` answers are resolved from raw codes (`"opt_a"`) to human-readable choice labels (`"Yes, has access to clean water"`) using the form's choice lists — pass `resolveLabels: false` for raw codes, or `language` for a non-default form language.
- `get_submission_stats` — total count, date range, and a trend bucketed by day/week/month.
- `flag_incomplete_submissions` — submissions missing an answer for a required question, including questions inside repeat groups (checked per repeat instance, best-effort — see Notes).
- `get_submission_attachments` — list photo/audio/video/file attachments for one submission, with download URLs.
- `view_submission_attachment` — fetch one image or audio attachment and return its actual content inline (viewable directly), not just a URL. Video/documents aren't supported inline — use `get_submission_attachments` for those.
- `get_geo_submissions` — submissions with a geopoint answer, as GeoJSON (default) or plain JSON, with optional bounding-box filtering.
- `get_validation_summary` — breakdown of submissions by Kobo's manual validation status (Approved / Not Approved / On Hold / not reviewed).
- `find_duplicate_submissions` — submissions sharing the same value for a given field (e.g. a phone number or ID question).
- `get_field_distribution` — answer distribution for one question: category counts/percentages for choice or text questions, or min/max/mean/median for numeric questions.
- `export_submissions_csv` — submissions as CSV text for the agent to save or hand off to another tool. Same choice-label resolution as `get_submissions`, on by default.

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

## Publishing (for maintainers)

Not yet published anywhere — this repo is currently the only distribution channel. To publish:

1. **npm** (required before the MCP Registry, since the registry only hosts metadata):

   ```sh
   npm login
   npm publish --access public
   ```

2. **MCP Registry** ([server.json](server.json) is already set up per the [official schema](https://modelcontextprotocol.io/registry/quickstart)):

   ```sh
   # install mcp-publisher (see quickstart link above for your platform)
   mcp-publisher login github
   mcp-publisher publish
   ```

3. **GitHub repo**: make it public (Settings → General → Danger Zone → Change visibility), then add topics `mcp`, `model-context-protocol`, `kobotoolbox`, `odk`, `ai-agent` for discoverability.

## Scope

- Read-only by design: no tool creates, edits, or deletes forms or submissions.
- KoboToolbox only. ODK Central uses a different auth model (session login, no static API token) and a different submissions API (OData-based); it's deliberately out of scope for this server rather than bolted on unverified.

## Data protection & liability

**This is not legal advice, and nothing here is a guarantee against legal risk.** Whether it's safe to connect this server to real survey data is a legal/compliance question (data protection law, your org's data-sharing agreements with beneficiaries or donors, sector rules for protection/health data) that only your own legal counsel or DPO can answer for your situation — code can reduce exposure, but it can't clear you.

What this project does to reduce risk, and what remains your responsibility:

- **You are the data controller, not this tool.** This server is a pass-through: it can only see what your `KOBO_API_TOKEN` can already see. Scope the token to the narrowest account/role that has what you need — Kobo tokens are per-user, so create a dedicated account with access to only the relevant forms if you can.
- **`KOBO_REDACT_FIELDS`** — set this to a comma-separated list of field names (e.g. `phone,national_id,name`) to have the server replace those values with `[REDACTED]` in every tool's output, unconditionally. This is enforced once, in the API client, so it can't be bypassed by any current or future tool — including CSV export and duplicate detection (which means a redacted field can no longer be used for deduplication; that trade-off is intentional, since leaking the value would be worse).
- **Nothing is logged.** Response bodies (submission content, attachment contents) are never written to stdout/stderr/disk by this server; only error messages and, if configured, the list of redacted field names at startup.
- **Read-only.** No tool can alter or delete Kobo data, which limits the blast radius of a misused token but doesn't address disclosure.
- **Downstream data flow is outside this server's control.** Whatever a tool returns becomes part of the conversation sent to your AI provider (e.g. Anthropic) and may be retained per that provider's data-handling terms — check those terms if that matters for your compliance obligations, independent of anything this server does.
- **The MIT license's "AS IS" clause** (see [LICENSE](LICENSE)) disclaims warranty and liability for the software itself, which is standard for open source — it does not and cannot discharge your obligations as a data controller when you choose to connect this to production beneficiary/protection data.

If you're deploying this against real humanitarian or personal data, the practical checklist before you do: get sign-off from whoever owns data protection compliance at your org, scope the API token tightly, and set `KOBO_REDACT_FIELDS` for anything you don't want an AI model to ever see.

## Notes

- Submission payloads (and attachments) can contain personal or sensitive data (names, GPS, photos, health/protection info) — this server doesn't log response bodies, and `get_submissions`/`export_submissions_csv`/`get_geo_submissions` support field selection to request only what's needed.
- `get_submissions` caps `limit` at 100 per call; page through with `start` for larger pulls. The scanning tools (`get_submission_stats`, `flag_incomplete_submissions`, `get_geo_submissions`, `get_validation_summary`, `find_duplicate_submissions`, `get_field_distribution`, `export_submissions_csv`) page internally up to a `maxRows` cap (default varies by tool, hard max 2000) to avoid unbounded API usage.
- `view_submission_attachment` only returns `image/*` and `audio/*` attachments, and rejects anything over 8MB (use a smaller `size` for images, or `get_submission_attachments`'s download URL directly for large/video/document files). Like everything else, the fetched bytes are never logged.
- `get_field_distribution` counts `select_multiple` answers per selected option, not per submission — a submission with 3 selected options contributes to 3 categories, so percentages (of respondents who answered) don't sum to 100. If the field is in `KOBO_REDACT_FIELDS`, every value is `[REDACTED]` before this tool sees it, so the distribution collapses to a single 100% category — a visibly wrong result, not a silent leak, consistent with how redaction affects `find_duplicate_submissions`.
- Requests retry automatically on transient failures (429/502/503/504 or network errors), up to 2 retries with backoff; 4xx errors (bad token, missing form) fail immediately and are returned as a tool error rather than crashing the server. Verified live against a real KoboToolbox server with an invalid token.
- `flag_incomplete_submissions`'s repeat-group handling is best-effort: it matches submission JSON keys by the question's full path first, falling back to the bare question name, since Kobo's export shape for nested repeats isn't fully documented and hasn't been verified against a live account with repeat groups.
- If a field is both `required` and in `KOBO_REDACT_FIELDS`, `flag_incomplete_submissions` will see `[REDACTED]` (a non-empty string) rather than the real value, so a genuinely blank answer on that field won't be flagged as missing — redaction is applied before any tool logic runs, with no exceptions. Similarly, redacting the field passed to `find_duplicate_submissions` makes every submission look identical on that field (a visibly wrong result, not a silent leak). Both are the deliberate cost of enforcing redaction in one place rather than per-tool.
- Choice-label resolution only handles `select_one` and `select_multiple` question types (not e.g. `select_one_from_file`), matches choices to questions by the form's `content.choices`/`select_from_list_name`, and applies inside repeat groups using the same best-effort key matching as `flag_incomplete_submissions`. `resolveLabels` costs one extra `get_form_summary` call per `get_submissions`/`export_submissions_csv` call, mitigated by the form-schema cache. `query`/`sort` always operate on raw stored codes — resolution only affects what's returned, never what's matched.
- Not yet verified against a real KoboToolbox account with actual form data (including choice-label resolution, attachment viewing, and field distributions) — the connected account currently has zero forms. Verified so far: auth/error paths (401/404) against the live API, tool schemas via a live `tools/list` call, and all response-shape assumptions against unit tests with mocked responses (60 tests as of this feature).

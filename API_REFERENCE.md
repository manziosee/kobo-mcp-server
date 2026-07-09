# API reference: MCP tools → KoboToolbox REST endpoints

This server is an MCP (stdio) server, not a REST API — there's no Swagger/OpenAPI surface for it directly.
This doc instead maps each MCP tool to the real KoboToolbox REST endpoint(s) it calls, so you can:

- know exactly what a tool does before running it against real data,
- reproduce/debug any tool's behavior directly with `curl` or Postman, independent of MCP,
- test the underlying Kobo API access itself using nothing but your `KOBO_API_TOKEN`.

All requests use `Authorization: Token <KOBO_API_TOKEN>` and `Accept: application/json` headers
(see [src/kobo-client.ts](src/kobo-client.ts)). `{base}` is your `KOBO_BASE_URL`
(default `https://kf.kobotoolbox.org`; EU server `https://eu.kobotoolbox.org`).

## Try it with curl

```sh
curl -H "Authorization: Token $KOBO_API_TOKEN" "https://kf.kobotoolbox.org/api/v2/assets/?asset_type=survey&limit=100"
```

A 200 with `{"count": 0, ...}` (or a list of forms) confirms the token/base URL are valid — that's exactly
what `list_forms` does under the hood.

## Tool → endpoint map

| MCP tool | Kobo REST endpoint(s) | Notes |
|---|---|---|
| `list_forms` | `GET {base}/api/v2/assets/?asset_type=survey&limit=100` | Follows the `next` pagination link until exhausted. |
| `get_form_summary` | `GET {base}/api/v2/assets/{uid}/` | Reads `content.survey`/`content.choices`/`content.translations`. Cached in memory (`formSummaryCacheTtlMs`, default 5 min). |
| `get_submissions` | `GET {base}/api/v2/assets/{uid}/data/?start=&limit=&query=&sort=&fields=` | `query`/`sort`/`fields` are JSON-encoded Mongo-style params, passed through as-is. Also calls `get_form_summary`'s endpoint if `resolveLabels` is true. |
| `get_submission_stats` | `GET {base}/api/v2/assets/{uid}/data/` (paged, `fields=["_submission_time"]`) | Multiple calls up to `maxRows`, aggregated client-side. |
| `flag_incomplete_submissions` | `GET {base}/api/v2/assets/{uid}/` + `GET {base}/api/v2/assets/{uid}/data/` (paged) | Form endpoint for required-question list, data endpoint for scanning. |
| `get_submission_attachments` | `GET {base}/api/v2/assets/{uid}/data/{submissionId}/` | Reads `_attachments` off the single-submission response. |
| `view_submission_attachment` | `GET {base}/api/v2/assets/{uid}/data/{submissionId}/` then `GET <download_url>` | The second request hits Kobo's media host directly (still with the same `Authorization: Token` header), not `/api/v2/`. |
| `get_geo_submissions` | `GET {base}/api/v2/assets/{uid}/` (to auto-detect the geo field) + `GET {base}/api/v2/assets/{uid}/data/` (paged) | Form endpoint skipped if `geoField` is passed explicitly. |
| `get_validation_summary` | `GET {base}/api/v2/assets/{uid}/data/` (paged, `fields=["_validation_status"]`) | |
| `find_duplicate_submissions` | `GET {base}/api/v2/assets/{uid}/data/` (paged, `fields=[field]`) | |
| `get_field_distribution` | `GET {base}/api/v2/assets/{uid}/` + `GET {base}/api/v2/assets/{uid}/data/` (paged, `fields=[field]`) | Form endpoint for question type/choice list. |
| `export_submissions_csv` | `GET {base}/api/v2/assets/{uid}/data/` (paged) + `GET {base}/api/v2/assets/{uid}/` if `resolveLabels` | |
| `search_all_forms` | `GET {base}/api/v2/assets/?asset_type=survey&limit=100` + `GET {base}/api/v2/assets/{uid}/` + `GET {base}/api/v2/assets/{uid}/data/` (paged) per candidate form | One form-summary + one data scan per form that has a matching question; forms without one are skipped without a data call. |
| Resource `kobo://forms/{uid}` | Same as `get_form_summary` | |

`sinceDate`/`untilDate` (on `get_submissions`, `get_submission_stats`, `flag_incomplete_submissions`, `get_geo_submissions`,
`get_validation_summary`, `find_duplicate_submissions`, `get_field_distribution`, `export_submissions_csv`) don't add a new
endpoint — they're translated client-side into a `_submission_time` range and passed as the existing `query` param above.

All "(paged)" endpoints request up to 100 rows per call (`limit`, hard-capped by Kobo) and loop until
`maxRows` or the true result count is reached — see `getManySubmissions` in
[src/kobo-client.ts](src/kobo-client.ts).

## Kobo's own API docs

KoboToolbox publishes its full REST API reference at `{base}/api/v2/` (browsable DRF docs) and
`https://support.kobotoolbox.org/api.html`. This project only uses the small slice of endpoints listed
above — read-only, per-asset data and metadata.

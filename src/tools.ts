import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { KoboApiError, type KoboClient } from "./kobo-client.js";
import { rowsToCsv } from "./csv.js";

const MAX_SUBMISSION_LIMIT = 100;
const MAX_SCAN_ROWS = 2000;

function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof KoboApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function withErrorHandling<Args extends Record<string, unknown>>(
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

type BucketSize = "day" | "week" | "month";

function bucketKey(dateIso: string, bucket: BucketSize): string {
  const d = new Date(dateIso);
  if (bucket === "month") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (bucket === "week") {
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dayOfWeek);
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

export function registerTools(server: McpServer, client: KoboClient): void {
  server.registerTool(
    "list_forms",
    {
      title: "List Kobo forms",
      description:
        "List all survey forms (assets) accessible to this API token, with deployment status and submission counts. Use this first to find a form's uid before pulling submissions.",
      inputSchema: {},
    },
    withErrorHandling(async () => ok(await client.listForms())),
  );

  server.registerTool(
    "get_form_summary",
    {
      title: "Get Kobo form summary",
      description:
        "Get metadata for one form: deployment status, submission count, dates, and the list of questions (name, type, label, required). Use this to understand a form's structure before querying submissions.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms (e.g. 'aSAvYreNzVEkrWg5Gdcvg')"),
      },
    },
    withErrorHandling(async ({ uid }: { uid: string }) => ok(await client.getFormSummary(uid))),
  );

  server.registerTool(
    "get_submissions",
    {
      title: "Get Kobo form submissions",
      description:
        `Fetch submissions for a form, paginated (max ${MAX_SUBMISSION_LIMIT} per call). Supports a Mongo-style query filter, sort, and field selection to keep responses small. ` +
        "Submission data may contain personal or sensitive information (names, GPS coordinates, health/protection data) — treat it accordingly and avoid restating it unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Optional Mongo-style filter, e.g. {\"_submission_time\": {\"$gte\": \"2026-07-01\"}} or {\"group/city\": \"Kigali\"}",
          ),
        start: z.number().int().min(0).optional().describe("Offset for pagination, default 0"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SUBMISSION_LIMIT)
          .optional()
          .describe(`Max submissions to return (<= ${MAX_SUBMISSION_LIMIT}), default 30`),
        sort: z
          .record(z.string(), z.union([z.literal(1), z.literal(-1)]))
          .optional()
          .describe('Optional sort, e.g. {"_submission_time": -1} for newest first'),
        fields: z
          .array(z.string())
          .optional()
          .describe("Optional list of field names to return instead of the full submission"),
      },
    },
    withErrorHandling(
      async ({
        uid,
        query,
        start,
        limit,
        sort,
        fields,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        start?: number;
        limit?: number;
        sort?: Record<string, 1 | -1>;
        fields?: string[];
      }) => ok(await client.getSubmissions(uid, { query, start, limit, sort, fields })),
    ),
  );

  server.registerTool(
    "get_submission_stats",
    {
      title: "Get Kobo submission stats",
      description:
        "Summarize submission volume for a form: total count, date range, and a trend bucketed by day/week/month. " +
        `Scans up to ${MAX_SCAN_ROWS} submissions (only the timestamp field is fetched, not full payloads).`,
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional Mongo-style filter applied before bucketing, e.g. {\"group/city\": \"Kigali\"}"),
        bucket: z.enum(["day", "week", "month"]).optional().describe("Trend bucket size, default 'day'"),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan (<= ${MAX_SCAN_ROWS}), default ${MAX_SCAN_ROWS}`),
      },
    },
    withErrorHandling(
      async ({
        uid,
        query,
        bucket = "day",
        maxRows,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        bucket?: BucketSize;
        maxRows?: number;
      }) => {
        const { rows, totalCount, truncated } = await client.getManySubmissions(uid, {
          query,
          fields: ["_submission_time"],
          maxRows,
        });

        const counts = new Map<string, number>();
        let earliest: string | null = null;
        let latest: string | null = null;

        for (const row of rows) {
          const ts = row["_submission_time"];
          if (typeof ts !== "string") continue;
          if (!earliest || ts < earliest) earliest = ts;
          if (!latest || ts > latest) latest = ts;
          const key = bucketKey(ts, bucket);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        const trend = Array.from(counts.entries())
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([period, count]) => ({ period, count }));

        return ok({
          totalCount,
          scannedCount: rows.length,
          truncated,
          dateRange: { earliest, latest },
          bucket,
          trend,
        });
      },
    ),
  );

  server.registerTool(
    "flag_incomplete_submissions",
    {
      title: "Flag incomplete Kobo submissions",
      description:
        "Find submissions missing an answer for one of the form's required questions. " +
        "Compares each scanned submission against the form's required-field list from get_form_summary. " +
        "Note: only checks top-level (non-repeat-group) required questions.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan (<= ${MAX_SCAN_ROWS}), default 200`),
      },
    },
    withErrorHandling(async ({ uid, maxRows }: { uid: string; maxRows?: number }) => {
      const summary = await client.getFormSummary(uid);
      const requiredFields = summary.questions.filter((q) => q.required).map((q) => q.name);

      if (requiredFields.length === 0) {
        return ok({
          formUid: uid,
          requiredFieldCount: 0,
          message: "This form has no questions marked required; nothing to flag.",
        });
      }

      const scanLimit = maxRows ?? 200;
      const { rows, truncated } = await client.getManySubmissions(uid, {
        fields: [...requiredFields, "_id", "_uuid", "_submission_time"],
        maxRows: scanLimit,
      });

      const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

      const incomplete = rows
        .map((row) => ({
          _id: row["_id"],
          _uuid: row["_uuid"],
          _submission_time: row["_submission_time"],
          missingFields: requiredFields.filter((f) => isEmpty(row[f])),
        }))
        .filter((r) => r.missingFields.length > 0);

      const MAX_REPORTED = 50;
      return ok({
        formUid: uid,
        requiredFieldCount: requiredFields.length,
        scannedCount: rows.length,
        scanTruncated: truncated,
        incompleteCount: incomplete.length,
        incomplete: incomplete.slice(0, MAX_REPORTED),
        reportTruncated: incomplete.length > MAX_REPORTED,
      });
    }),
  );

  server.registerTool(
    "export_submissions_csv",
    {
      title: "Export Kobo submissions as CSV",
      description:
        "Fetch submissions for a form and return them as CSV text (not a file) for the agent to save or analyze further. " +
        "Contains raw submission data, which may be sensitive — avoid restating it unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional Mongo-style filter, e.g. {\"_submission_time\": {\"$gte\": \"2026-07-01\"}}"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Optional list of field names/columns to include instead of all fields"),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max rows to export (<= ${MAX_SCAN_ROWS}), default 500`),
      },
    },
    withErrorHandling(
      async ({
        uid,
        query,
        fields,
        maxRows,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        fields?: string[];
        maxRows?: number;
      }) => {
        const { rows, totalCount, truncated } = await client.getManySubmissions(uid, {
          query,
          fields,
          maxRows: maxRows ?? 500,
        });

        const csv = rowsToCsv(rows, fields);
        const note = truncated
          ? `\n\n(Note: exported ${rows.length} of ${totalCount} matching submissions; increase maxRows or narrow the query for more.)`
          : "";

        return { content: [{ type: "text", text: `${csv}${note}` }] };
      },
    ),
  );
}

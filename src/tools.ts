import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { KoboApiError, MAX_ATTACHMENT_BYTES, type KoboClient } from "./kobo-client.js";
import { rowsToCsv } from "./csv.js";
import { parseGeopoint, isWithinBBox, toFeatureCollection, type GeoPoint, type BoundingBox } from "./geo.js";
import { buildChoiceIndex, resolveChoiceLabel, resolveLanguageIndex, resolveRecordLabels } from "./choices.js";

const MAX_SUBMISSION_LIMIT = 100;
const MAX_SCAN_ROWS = 2000;
const DEFAULT_MAX_FORMS_SCANNED = 50;
const MAX_FORMS_SCANNED = 100;

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

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

const sinceUntilSchema = {
  sinceDate: z
    .string()
    .optional()
    .describe("Only include submissions on/after this date (ISO 8601, e.g. '2026-07-01'). Shorthand for a _submission_time $gte filter."),
  untilDate: z
    .string()
    .optional()
    .describe("Only include submissions on/before this date (ISO 8601). Shorthand for a _submission_time $lte filter."),
};

/**
 * Merges sinceDate/untilDate convenience params into a Mongo-style query as a _submission_time
 * range, overriding any _submission_time key already in query (documented in each tool's schema).
 */
function withDateRange(
  query: Record<string, unknown> | undefined,
  sinceDate: string | undefined,
  untilDate: string | undefined,
): Record<string, unknown> | undefined {
  if (!sinceDate && !untilDate) return query;
  const range: Record<string, string> = {};
  if (sinceDate) range.$gte = sinceDate;
  if (untilDate) range.$lte = untilDate;
  return { ...query, _submission_time: range };
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

/** Resolves select_one/select_multiple codes to human-readable labels using the form's choice lists. No-op if the form has no choices. */
async function applyLabelResolution(
  client: KoboClient,
  uid: string,
  rows: Record<string, unknown>[],
  language: string | undefined,
): Promise<Record<string, unknown>[]> {
  const summary = await client.getFormSummary(uid);
  if (summary.choices.length === 0) return rows;

  const index = buildChoiceIndex(summary.choices);
  const languageIndex = resolveLanguageIndex(summary.translations, language);
  return rows.map((row) => resolveRecordLabels(row, summary.questions, index, languageIndex));
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
        "Get metadata for one form: deployment status, submission count, dates, and the list of questions (name, full path, type, label, required, enclosing repeat group). " +
        "Use this to understand a form's structure before querying submissions. Cached in memory for a few minutes per form.",
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
        "By default, select_one/select_multiple answers are resolved from raw codes (e.g. \"opt_a\") to their human-readable choice labels (e.g. \"Yes, has access to clean water\") using the form's choice lists — pass resolveLabels: false for raw codes instead. " +
        "Submission data may contain personal or sensitive information (names, GPS coordinates, health/protection data) — treat it accordingly and avoid restating it unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Optional Mongo-style filter, e.g. {\"_submission_time\": {\"$gte\": \"2026-07-01\"}} or {\"group/city\": \"Kigali\"}. Filters always match raw stored codes, not resolved labels.",
          ),
        ...sinceUntilSchema,
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
        resolveLabels: z
          .boolean()
          .optional()
          .describe("Resolve select_one/select_multiple codes to choice labels, default true"),
        language: z
          .string()
          .optional()
          .describe("Language name for resolved labels (e.g. 'French'), for multi-language forms; defaults to the form's first/default language"),
      },
    },
    withErrorHandling(
      async ({
        uid,
        query,
        sinceDate,
        untilDate,
        start,
        limit,
        sort,
        fields,
        resolveLabels = true,
        language,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        sinceDate?: string;
        untilDate?: string;
        start?: number;
        limit?: number;
        sort?: Record<string, 1 | -1>;
        fields?: string[];
        resolveLabels?: boolean;
        language?: string;
      }) => {
        const page = await client.getSubmissions(uid, {
          query: withDateRange(query, sinceDate, untilDate),
          start,
          limit,
          sort,
          fields,
        });
        if (!resolveLabels) return ok(page);
        const results = await applyLabelResolution(client, uid, page.results, language);
        return ok({ count: page.count, results });
      },
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
        ...sinceUntilSchema,
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
        sinceDate,
        untilDate,
        bucket = "day",
        maxRows,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        sinceDate?: string;
        untilDate?: string;
        bucket?: BucketSize;
        maxRows?: number;
      }) => {
        const { rows, totalCount, truncated } = await client.getManySubmissions(uid, {
          query: withDateRange(query, sinceDate, untilDate),
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
        "Find submissions missing an answer for one of the form's required questions, including questions inside repeat groups " +
        "(each repeat instance is checked separately). Best-effort for repeat groups: matches submission JSON keys by full question " +
        "path first, falling back to the bare question name, since Kobo's export shape for nested repeats can vary by form.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        ...sinceUntilSchema,
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan (<= ${MAX_SCAN_ROWS}), default 200`),
      },
    },
    withErrorHandling(async ({ uid, sinceDate, untilDate, maxRows }: { uid: string; sinceDate?: string; untilDate?: string; maxRows?: number }) => {
      const summary = await client.getFormSummary(uid);
      const required = summary.questions.filter((q) => q.required);

      if (required.length === 0) {
        return ok({
          formUid: uid,
          requiredFieldCount: 0,
          message: "This form has no questions marked required; nothing to flag.",
        });
      }

      const topLevel = required.filter((q) => q.repeatPath === null);
      const nested = required.filter((q) => q.repeatPath !== null);
      const repeatPaths = Array.from(new Set(nested.map((q) => q.repeatPath as string)));

      const scanLimit = maxRows ?? 200;
      const { rows, truncated } = await client.getManySubmissions(uid, {
        query: withDateRange(undefined, sinceDate, untilDate),
        fields: [...topLevel.map((q) => q.path), ...repeatPaths, "_id", "_uuid", "_submission_time"],
        maxRows: scanLimit,
      });

      const incomplete = rows
        .map((row) => {
          const missingFields: string[] = [];

          for (const q of topLevel) {
            if (isEmpty(row[q.path])) missingFields.push(q.path);
          }

          for (const repeatPath of repeatPaths) {
            const instances = row[repeatPath];
            if (!Array.isArray(instances)) continue;
            const questionsInThisRepeat = nested.filter((q) => q.repeatPath === repeatPath);

            instances.forEach((instance, idx) => {
              if (typeof instance !== "object" || instance === null) return;
              const record = instance as Record<string, unknown>;
              for (const q of questionsInThisRepeat) {
                const value = record[q.path] ?? record[q.name];
                if (isEmpty(value)) missingFields.push(`${repeatPath}[${idx}].${q.name}`);
              }
            });
          }

          return {
            _id: row["_id"],
            _uuid: row["_uuid"],
            _submission_time: row["_submission_time"],
            missingFields,
          };
        })
        .filter((r) => r.missingFields.length > 0);

      const MAX_REPORTED = 50;
      return ok({
        formUid: uid,
        requiredFieldCount: required.length,
        scannedCount: rows.length,
        scanTruncated: truncated,
        incompleteCount: incomplete.length,
        incomplete: incomplete.slice(0, MAX_REPORTED),
        reportTruncated: incomplete.length > MAX_REPORTED,
      });
    }),
  );

  server.registerTool(
    "get_submission_attachments",
    {
      title: "Get Kobo submission attachments",
      description:
        "List media attachments (photos, audio, video, files) for one submission, with download URLs. " +
        "Download URLs require the same API token to fetch and may point to sensitive media (e.g. photos of people) — avoid restating or describing contents unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        submissionId: z
          .union([z.string(), z.number()])
          .describe("The submission's _id, from get_submissions or get_submission_stats"),
      },
    },
    withErrorHandling(async ({ uid, submissionId }: { uid: string; submissionId: string | number }) =>
      ok(await client.getSubmissionAttachments(uid, submissionId)),
    ),
  );

  server.registerTool(
    "view_submission_attachment",
    {
      title: "View a Kobo submission attachment",
      description:
        "Fetch one image or audio attachment from a submission and return its actual content inline (viewable directly), " +
        "rather than just a download URL. Only image/* and audio/* attachments are supported - for video or documents, use " +
        `get_submission_attachments for the download URL instead. Rejects attachments over ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB; ` +
        "pass a smaller size for large images. May return sensitive media (e.g. photos of people) - avoid restating or describing contents unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        submissionId: z
          .union([z.string(), z.number()])
          .describe("The submission's _id, from get_submissions or get_submission_stats"),
        attachmentId: z
          .union([z.string(), z.number()])
          .describe("The attachment's id, from get_submission_attachments"),
        size: z
          .enum(["small", "medium", "large", "original"])
          .optional()
          .describe("Image variant to fetch, default 'medium'. Ignored for audio, which is always fetched as original."),
      },
    },
    withErrorHandling(
      async ({
        uid,
        submissionId,
        attachmentId,
        size = "medium",
      }: {
        uid: string;
        submissionId: string | number;
        attachmentId: string | number;
        size?: "small" | "medium" | "large" | "original";
      }) => {
        const attachments = await client.getSubmissionAttachments(uid, submissionId);
        const attachment = attachments.find((a) => String(a.id) === String(attachmentId));
        if (!attachment) {
          return errorResult(new Error(`No attachment with id ${attachmentId} on submission ${submissionId}.`));
        }

        const isImage = attachment.mimetype.startsWith("image/");
        const isAudio = attachment.mimetype.startsWith("audio/");
        if (!isImage && !isAudio) {
          return errorResult(
            new Error(
              `Attachment mimetype "${attachment.mimetype}" isn't viewable inline; use get_submission_attachments for its download URL.`,
            ),
          );
        }

        const urlBySize: Record<string, string | null> = {
          small: attachment.downloadSmallUrl,
          medium: attachment.downloadMediumUrl,
          large: attachment.downloadLargeUrl,
          original: attachment.downloadUrl,
        };
        const url = (isImage ? urlBySize[size] : null) ?? attachment.downloadUrl;
        if (!url) {
          return errorResult(new Error(`No download URL available for attachment ${attachmentId}.`));
        }

        const content = await client.fetchAttachmentContent(url);
        return {
          content: [
            isImage
              ? { type: "image" as const, data: content.data, mimeType: content.mimeType }
              : { type: "audio" as const, data: content.data, mimeType: content.mimeType },
          ],
        };
      },
    ),
  );

  server.registerTool(
    "get_geo_submissions",
    {
      title: "Get geo-tagged Kobo submissions",
      description:
        "Fetch submissions that have a geopoint answer and return them as GeoJSON (default) or plain JSON, optionally filtered to a bounding box. " +
        "Auto-detects the form's first geopoint/geotrace/geoshape question unless geoField is given (use get_form_summary to find question paths/types).",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        geoField: z
          .string()
          .optional()
          .describe("Full path of the geopoint question to use, e.g. 'household/location'; auto-detected if omitted"),
        bbox: z
          .object({
            minLat: z.number(),
            minLon: z.number(),
            maxLat: z.number(),
            maxLon: z.number(),
          })
          .optional()
          .describe("Optional bounding box filter, applied after fetching"),
        format: z.enum(["geojson", "json"]).optional().describe("Output format, default 'geojson'"),
        properties: z
          .array(z.string())
          .optional()
          .describe("Extra submission fields to include as properties on each point"),
        ...sinceUntilSchema,
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan (<= ${MAX_SCAN_ROWS}), default 500`),
      },
    },
    withErrorHandling(
      async ({
        uid,
        geoField,
        bbox,
        format = "geojson",
        properties,
        sinceDate,
        untilDate,
        maxRows,
      }: {
        uid: string;
        geoField?: string;
        bbox?: BoundingBox;
        format?: "geojson" | "json";
        properties?: string[];
        sinceDate?: string;
        untilDate?: string;
        maxRows?: number;
      }) => {
        let field = geoField;
        if (!field) {
          const summary = await client.getFormSummary(uid);
          const geoQuestion = summary.questions.find(
            (q) => q.type === "geopoint" || q.type === "geotrace" || q.type === "geoshape",
          );
          if (!geoQuestion) {
            return ok({
              formUid: uid,
              message: "This form has no geopoint/geotrace/geoshape question. Pass geoField explicitly if one exists under a different type.",
            });
          }
          field = geoQuestion.path;
        }

        const extraProps = properties ?? [];
        const { rows, truncated } = await client.getManySubmissions(uid, {
          query: withDateRange(undefined, sinceDate, untilDate),
          fields: [field, "_id", "_uuid", "_submission_time", ...extraProps],
          maxRows: maxRows ?? 500,
        });

        const points = rows
          .map((row) => ({ row, point: parseGeopoint(row[field as string]) }))
          .filter((r): r is { row: Record<string, unknown>; point: GeoPoint } => r.point !== null)
          .filter((r) => !bbox || isWithinBBox(r.point, bbox));

        const propsFor = (row: Record<string, unknown>) => ({
          _id: row["_id"],
          _uuid: row["_uuid"],
          _submission_time: row["_submission_time"],
          ...Object.fromEntries(extraProps.map((p) => [p, row[p]])),
        });

        if (format === "json") {
          return ok({
            formUid: uid,
            geoField: field,
            scannedCount: rows.length,
            matchedCount: points.length,
            scanTruncated: truncated,
            points: points.map(({ row, point }) => ({ ...propsFor(row), ...point })),
          });
        }

        const featureCollection = toFeatureCollection(
          points.map(({ row, point }) => ({ point, properties: propsFor(row) })),
        );

        return ok({
          formUid: uid,
          geoField: field,
          scannedCount: rows.length,
          matchedCount: points.length,
          scanTruncated: truncated,
          ...featureCollection,
        });
      },
    ),
  );

  server.registerTool(
    "get_validation_summary",
    {
      title: "Get Kobo validation status summary",
      description:
        "Summarize submissions by Kobo's manual validation status (e.g. Approved / Not Approved / On Hold / not yet reviewed), " +
        "with counts and percentages. Useful for M&E teams tracking review progress.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        ...sinceUntilSchema,
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan (<= ${MAX_SCAN_ROWS}), default ${MAX_SCAN_ROWS}`),
      },
    },
    withErrorHandling(async ({ uid, sinceDate, untilDate, maxRows }: { uid: string; sinceDate?: string; untilDate?: string; maxRows?: number }) => {
      const { rows, totalCount, truncated } = await client.getManySubmissions(uid, {
        query: withDateRange(undefined, sinceDate, untilDate),
        fields: ["_validation_status"],
        maxRows,
      });

      const counts = new Map<string, number>();
      for (const row of rows) {
        const status = row["_validation_status"];
        let key = "not_reviewed";
        if (status && typeof status === "object" && "uid" in (status as Record<string, unknown>)) {
          key = String((status as Record<string, unknown>).uid ?? "not_reviewed") || "not_reviewed";
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      const breakdown = Array.from(counts.entries())
        .map(([status, count]) => ({
          status,
          count,
          percent: rows.length ? Math.round((count / rows.length) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count);

      return ok({ formUid: uid, totalCount, scannedCount: rows.length, scanTruncated: truncated, breakdown });
    }),
  );

  server.registerTool(
    "find_duplicate_submissions",
    {
      title: "Find duplicate Kobo submissions",
      description:
        "Find submissions that share the same value for a given field (e.g. a phone number or national ID question) — " +
        "a common field-data quality check. Blank/missing values are ignored.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        field: z.string().describe("Field name/path to check for duplicate values, from get_form_summary"),
        ...sinceUntilSchema,
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
        field,
        sinceDate,
        untilDate,
        maxRows,
      }: {
        uid: string;
        field: string;
        sinceDate?: string;
        untilDate?: string;
        maxRows?: number;
      }) => {
      const { rows, truncated } = await client.getManySubmissions(uid, {
        query: withDateRange(undefined, sinceDate, untilDate),
        fields: [field, "_id", "_uuid", "_submission_time"],
        maxRows,
      });

      const groups = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const value = row[field];
        if (isEmpty(value)) continue;
        const key = String(value);
        const list = groups.get(key) ?? [];
        list.push({ _id: row["_id"], _uuid: row["_uuid"], _submission_time: row["_submission_time"] });
        groups.set(key, list);
      }

      const duplicates = Array.from(groups.entries())
        .filter(([, list]) => list.length > 1)
        .map(([value, submissions]) => ({ value, count: submissions.length, submissions }));

      return ok({
        formUid: uid,
        field,
        scannedCount: rows.length,
        scanTruncated: truncated,
        duplicateGroupCount: duplicates.length,
        duplicates,
      });
    }),
  );

  server.registerTool(
    "export_submissions_csv",
    {
      title: "Export Kobo submissions as CSV",
      description:
        "Fetch submissions for a form and return them as CSV text (not a file) for the agent to save or analyze further. " +
        "By default, select_one/select_multiple answers are resolved to their human-readable choice labels (see get_submissions) — pass resolveLabels: false for raw codes instead. " +
        "Contains raw submission data, which may be sensitive — avoid restating it unnecessarily.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional Mongo-style filter, e.g. {\"_submission_time\": {\"$gte\": \"2026-07-01\"}}"),
        ...sinceUntilSchema,
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
        resolveLabels: z
          .boolean()
          .optional()
          .describe("Resolve select_one/select_multiple codes to choice labels, default true"),
        language: z
          .string()
          .optional()
          .describe("Language name for resolved labels, for multi-language forms; defaults to the form's first/default language"),
      },
    },
    withErrorHandling(
      async ({
        uid,
        query,
        sinceDate,
        untilDate,
        fields,
        maxRows,
        resolveLabels = true,
        language,
      }: {
        uid: string;
        query?: Record<string, unknown>;
        sinceDate?: string;
        untilDate?: string;
        fields?: string[];
        maxRows?: number;
        resolveLabels?: boolean;
        language?: string;
      }) => {
        const { rows, totalCount, truncated } = await client.getManySubmissions(uid, {
          query: withDateRange(query, sinceDate, untilDate),
          fields,
          maxRows: maxRows ?? 500,
        });

        const outputRows = resolveLabels ? await applyLabelResolution(client, uid, rows, language) : rows;
        const csv = rowsToCsv(outputRows, fields);
        const note = truncated
          ? `\n\n(Note: exported ${rows.length} of ${totalCount} matching submissions; increase maxRows or narrow the query for more.)`
          : "";

        return { content: [{ type: "text", text: `${csv}${note}` }] };
      },
    ),
  );

  server.registerTool(
    "get_field_distribution",
    {
      title: "Get Kobo field answer distribution",
      description:
        "Summarize the answers for one question across a form's submissions: category counts and percentages for choice/text questions, " +
        "or count/min/max/mean/median for numeric (integer/decimal/range) questions. select_multiple answers are counted per selected option " +
        "(a submission can count toward more than one category, so percentages need not sum to 100). Missing/blank answers are reported " +
        "separately and excluded from percentages.",
      inputSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
        field: z.string().describe("Field name/path to summarize, from get_form_summary"),
        resolveLabels: z
          .boolean()
          .optional()
          .describe("Resolve select_one/select_multiple codes to choice labels, default true"),
        language: z
          .string()
          .optional()
          .describe("Language name for resolved labels, for multi-language forms; defaults to the form's first/default language"),
        maxCategories: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max distinct categories to report for choice/text questions, default 30; the rest are folded into otherCount"),
        ...sinceUntilSchema,
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
        field,
        resolveLabels = true,
        language,
        maxCategories,
        sinceDate,
        untilDate,
        maxRows,
      }: {
        uid: string;
        field: string;
        resolveLabels?: boolean;
        language?: string;
        maxCategories?: number;
        sinceDate?: string;
        untilDate?: string;
        maxRows?: number;
      }) => {
        const summary = await client.getFormSummary(uid);
        const question = summary.questions.find((q) => q.path === field || q.name === field);

        const { rows, truncated } = await client.getManySubmissions(uid, {
          query: withDateRange(undefined, sinceDate, untilDate),
          fields: [field],
          maxRows,
        });

        let missingCount = 0;
        const values: unknown[] = [];
        for (const row of rows) {
          const raw = row[field];
          if (isEmpty(raw)) {
            missingCount++;
            continue;
          }
          values.push(raw);
        }

        const isNumeric = question ? ["integer", "decimal", "range"].includes(question.type) : false;

        if (isNumeric) {
          const numbers = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
          const sorted = [...numbers].sort((a, b) => a - b);
          const mean = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
          const mid = Math.floor(sorted.length / 2);
          const median = sorted.length
            ? sorted.length % 2 === 1
              ? sorted[mid]
              : (sorted[mid - 1] + sorted[mid]) / 2
            : null;

          return ok({
            formUid: uid,
            field,
            type: "numeric",
            scannedCount: rows.length,
            scanTruncated: truncated,
            answeredCount: numbers.length,
            missingCount,
            min: sorted.length ? sorted[0] : null,
            max: sorted.length ? sorted[sorted.length - 1] : null,
            mean: mean !== null ? Math.round(mean * 100) / 100 : null,
            median,
          });
        }

        const isSelectMultiple = question?.type === "select_multiple";
        const shouldResolve = Boolean(resolveLabels && question?.selectFromListName);
        const index = shouldResolve ? buildChoiceIndex(summary.choices) : null;
        const languageIndex = shouldResolve ? resolveLanguageIndex(summary.translations, language) : 0;

        const counts = new Map<string, number>();
        for (const raw of values) {
          const codes = isSelectMultiple ? String(raw).split(/\s+/).filter(Boolean) : [String(raw)];
          for (const code of codes) {
            const label =
              index && question?.selectFromListName
                ? resolveChoiceLabel(index, question.selectFromListName, code, languageIndex)
                : code;
            counts.set(label, (counts.get(label) ?? 0) + 1);
          }
        }

        const limit = maxCategories ?? 30;
        const sortedCounts = Array.from(counts.entries()).sort(([, a], [, b]) => b - a);
        const top = sortedCounts.slice(0, limit);
        const otherCount = sortedCounts.slice(limit).reduce((sum, [, c]) => sum + c, 0);
        const denominator = values.length;

        return ok({
          formUid: uid,
          field,
          type: question?.type ?? "unknown",
          scannedCount: rows.length,
          scanTruncated: truncated,
          answeredCount: values.length,
          missingCount,
          categories: top.map(([value, count]) => ({
            value,
            count,
            percent: denominator ? Math.round((count / denominator) * 1000) / 10 : 0,
          })),
          otherCategoryCount: Math.max(0, sortedCounts.length - top.length),
          otherCount,
          categoriesTruncated: sortedCounts.length > top.length,
        });
      },
    ),
  );

  server.registerTool(
    "search_all_forms",
    {
      title: "Search a field across all Kobo forms",
      description:
        "Find submissions with a given value in a given question, across every form the API token can see (e.g. find every " +
        "submission with a specific phone number or national ID, without knowing which form it was collected on). Matches a " +
        "question by its bare name (not full path), so it works even if the field lives at different paths on different forms; " +
        "only matches top-level questions (not ones inside repeat groups) since exact-match filtering doesn't reliably reach " +
        "into nested repeat data. Forms without a matching question, or that error while scanning, are reported separately, not silently dropped.",
      inputSchema: {
        field: z.string().describe("Bare question name to search for, e.g. 'phone_number' (not a full group/path)"),
        value: z.string().describe("Exact value to search for"),
        deploymentStatus: z
          .enum(["deployed", "archived", "draft", "any"])
          .optional()
          .describe("Only scan forms with this deployment status, default 'deployed' (draft forms have no submissions)"),
        maxForms: z
          .number()
          .int()
          .min(1)
          .max(MAX_FORMS_SCANNED)
          .optional()
          .describe(`Max forms to scan (<= ${MAX_FORMS_SCANNED}), default ${DEFAULT_MAX_FORMS_SCANNED}`),
        maxRowsPerForm: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_ROWS)
          .optional()
          .describe(`Max submissions to scan per matching form (<= ${MAX_SCAN_ROWS}), default 500`),
      },
    },
    withErrorHandling(
      async ({
        field,
        value,
        deploymentStatus = "deployed",
        maxForms,
        maxRowsPerForm,
      }: {
        field: string;
        value: string;
        deploymentStatus?: "deployed" | "archived" | "draft" | "any";
        maxForms?: number;
        maxRowsPerForm?: number;
      }) => {
        const allForms = await client.listForms();
        const candidateForms =
          deploymentStatus === "any" ? allForms : allForms.filter((f) => f.deploymentStatus === deploymentStatus);
        const forms = candidateForms.slice(0, maxForms ?? DEFAULT_MAX_FORMS_SCANNED);

        const matches: Array<{
          formUid: string;
          formName: string;
          _id: unknown;
          _uuid: unknown;
          _submission_time: unknown;
        }> = [];
        const formsSkipped: Array<{ formUid: string; formName: string; reason: string }> = [];
        let formsWithFieldCount = 0;

        for (const form of forms) {
          try {
            const summary = await client.getFormSummary(form.uid);
            const question = summary.questions.find((q) => q.name === field && q.repeatPath === null);
            if (!question) {
              formsSkipped.push({ formUid: form.uid, formName: form.name, reason: "no matching top-level question" });
              continue;
            }
            formsWithFieldCount++;

            const { rows } = await client.getManySubmissions(form.uid, {
              query: { [question.path]: value },
              fields: [question.path, "_id", "_uuid", "_submission_time"],
              maxRows: maxRowsPerForm ?? 500,
            });

            for (const row of rows) {
              matches.push({
                formUid: form.uid,
                formName: form.name,
                _id: row["_id"],
                _uuid: row["_uuid"],
                _submission_time: row["_submission_time"],
              });
            }
          } catch (err) {
            formsSkipped.push({
              formUid: form.uid,
              formName: form.name,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return ok({
          field,
          value,
          formsAvailable: candidateForms.length,
          formsScanned: forms.length,
          formsScanTruncated: candidateForms.length > forms.length,
          formsWithFieldCount,
          formsSkipped,
          matchCount: matches.length,
          matches,
        });
      },
    ),
  );
}

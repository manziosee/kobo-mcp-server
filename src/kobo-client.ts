import { buildQuestionPaths, type FormQuestion, type RawSurveyItem } from "./survey-schema.js";
import { buildRedactSet, redactRecord } from "./redact.js";

export type { FormQuestion } from "./survey-schema.js";

export interface KoboClientConfig {
  baseUrl: string;
  apiToken: string;
  /** How long to cache a form's schema (from getFormSummary) in memory, in ms. Default 5 minutes. Set 0 to disable. */
  formSummaryCacheTtlMs?: number;
  /**
   * Field names (bare, e.g. "phone_number", or full path, e.g. "household/phone_number") to
   * replace with "[REDACTED]" in every submission returned by this client, regardless of which
   * tool or query asked for them. Enforced here rather than per-tool so it can't be bypassed by
   * any current or future tool that reads submission data.
   */
  redactFields?: string[];
}

export interface FormListItem {
  uid: string;
  name: string;
  assetType: string;
  deploymentStatus: string;
  submissionCount: number | null;
  dateModified: string;
  dateDeployed: string | null;
  owner: string | null;
}

export interface FormSummary {
  uid: string;
  name: string;
  deploymentStatus: string;
  submissionCount: number | null;
  dateCreated: string;
  dateModified: string;
  dateDeployed: string | null;
  questionCount: number;
  questions: FormQuestion[];
}

export interface Attachment {
  id: number | string;
  filename: string;
  mimetype: string;
  downloadUrl: string | null;
  downloadSmallUrl: string | null;
  downloadMediumUrl: string | null;
  downloadLargeUrl: string | null;
}

export interface GetSubmissionsOptions {
  query?: Record<string, unknown>;
  start?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  fields?: string[];
}

export interface SubmissionsPage {
  count: number;
  results: Record<string, unknown>[];
}

export class KoboApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "KoboApiError";
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_FORM_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;

export class KoboClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly formSummaryCacheTtlMs: number;
  private readonly formSummaryCache = new Map<string, { data: FormSummary; expiresAt: number }>();
  private readonly redactKeys: Set<string>;

  constructor(config: KoboClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiToken = config.apiToken;
    this.formSummaryCacheTtlMs = config.formSummaryCacheTtlMs ?? DEFAULT_FORM_SUMMARY_CACHE_TTL_MS;
    this.redactKeys = buildRedactSet(config.redactFields);
  }

  private async request<T>(path: string, searchParams?: URLSearchParams): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (searchParams) {
      for (const [key, value] of searchParams) {
        url.searchParams.append(key, value);
      }
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Token ${this.apiToken}`,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new KoboApiError(
            `KoboToolbox API request failed (${response.status} ${response.statusText}) for ${path}: ${body.slice(0, 500)}`,
            response.status,
          );

          if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
            lastError = error;
            await sleep(BASE_BACKOFF_MS * 2 ** attempt);
            continue;
          }
          throw error;
        }

        return (await response.json()) as T;
      } catch (err) {
        if (err instanceof KoboApiError) throw err;
        // Network-level failure (DNS, connection reset, etc.) - retry.
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Request to ${path} failed after ${MAX_RETRIES + 1} attempts`);
  }

  async listForms(): Promise<FormListItem[]> {
    const items: FormListItem[] = [];
    let path: string | null = "/api/v2/assets/?asset_type=survey&limit=100";

    while (path) {
      const data: {
        results: Array<{
          uid: string;
          name: string;
          asset_type: string;
          deployment_status: string;
          deployment__submission_count: number | null;
          date_modified: string;
          date_deployed?: string | null;
          owner__username?: string | null;
        }>;
        next: string | null;
      } = await this.request(path.startsWith("http") ? path.replace(this.baseUrl, "") : path);

      for (const item of data.results) {
        items.push({
          uid: item.uid,
          name: item.name || "(untitled)",
          assetType: item.asset_type,
          deploymentStatus: item.deployment_status,
          submissionCount: item.deployment__submission_count ?? null,
          dateModified: item.date_modified,
          dateDeployed: item.date_deployed ?? null,
          owner: item.owner__username ?? null,
        });
      }

      path = data.next;
    }

    return items;
  }

  async getFormSummary(uid: string, options: { skipCache?: boolean } = {}): Promise<FormSummary> {
    const cached = this.formSummaryCache.get(uid);
    if (!options.skipCache && cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const data: {
      uid: string;
      name: string;
      deployment_status: string;
      deployment__submission_count: number | null;
      date_created: string;
      date_modified: string;
      date_deployed?: string | null;
      content?: {
        survey?: RawSurveyItem[];
      };
    } = await this.request(`/api/v2/assets/${encodeURIComponent(uid)}/`);

    const questions = buildQuestionPaths(data.content?.survey ?? []);

    const summary: FormSummary = {
      uid: data.uid,
      name: data.name || "(untitled)",
      deploymentStatus: data.deployment_status,
      submissionCount: data.deployment__submission_count ?? null,
      dateCreated: data.date_created,
      dateModified: data.date_modified,
      dateDeployed: data.date_deployed ?? null,
      questionCount: questions.length,
      questions,
    };

    if (this.formSummaryCacheTtlMs > 0) {
      this.formSummaryCache.set(uid, { data: summary, expiresAt: Date.now() + this.formSummaryCacheTtlMs });
    }

    return summary;
  }

  async getSubmissions(uid: string, options: GetSubmissionsOptions = {}): Promise<SubmissionsPage> {
    const params = new URLSearchParams();
    params.set("start", String(options.start ?? 0));
    params.set("limit", String(Math.min(options.limit ?? 30, 100)));

    if (options.query) {
      params.set("query", JSON.stringify(options.query));
    }
    if (options.sort) {
      params.set("sort", JSON.stringify(options.sort));
    }
    if (options.fields) {
      params.set("fields", JSON.stringify(options.fields));
    }

    const data: SubmissionsPage = await this.request(`/api/v2/assets/${encodeURIComponent(uid)}/data/`, params);
    return { count: data.count, results: data.results.map((r) => redactRecord(r, this.redactKeys)) };
  }

  async getSubmission(uid: string, submissionId: number | string): Promise<Record<string, unknown>> {
    const submission: Record<string, unknown> = await this.request(
      `/api/v2/assets/${encodeURIComponent(uid)}/data/${encodeURIComponent(String(submissionId))}/`,
    );
    return redactRecord(submission, this.redactKeys);
  }

  async getSubmissionAttachments(uid: string, submissionId: number | string): Promise<Attachment[]> {
    const submission = await this.getSubmission(uid, submissionId);
    const rawAttachments = submission["_attachments"];
    if (!Array.isArray(rawAttachments)) return [];

    return rawAttachments.map((a: Record<string, unknown>) => ({
      id: (a.id as number | string | undefined) ?? "",
      filename: (a.filename as string | undefined) ?? "(unknown)",
      mimetype: (a.mimetype as string | undefined) ?? "application/octet-stream",
      downloadUrl: (a.download_url as string | undefined) ?? null,
      downloadSmallUrl: (a.download_small_url as string | undefined) ?? null,
      downloadMediumUrl: (a.download_medium_url as string | undefined) ?? null,
      downloadLargeUrl: (a.download_large_url as string | undefined) ?? null,
    }));
  }

  /**
   * Pages through submissions internally up to maxRows, for tools that need
   * to scan/aggregate rather than return one page to the caller directly.
   */
  async getManySubmissions(
    uid: string,
    options: { query?: Record<string, unknown>; fields?: string[]; maxRows?: number } = {},
  ): Promise<{ rows: Record<string, unknown>[]; totalCount: number; truncated: boolean }> {
    const maxRows = options.maxRows ?? 2000;
    const pageSize = 100;
    const rows: Record<string, unknown>[] = [];
    let start = 0;
    let totalCount = 0;

    while (rows.length < maxRows) {
      const page = await this.getSubmissions(uid, {
        query: options.query,
        fields: options.fields,
        start,
        limit: Math.min(pageSize, maxRows - rows.length),
        sort: { _submission_time: 1 },
      });
      totalCount = page.count;
      rows.push(...page.results);
      start += page.results.length;
      if (page.results.length === 0 || start >= page.count) break;
    }

    return { rows, totalCount, truncated: totalCount > rows.length };
  }
}

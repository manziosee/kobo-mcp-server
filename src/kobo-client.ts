export interface KoboClientConfig {
  baseUrl: string;
  apiToken: string;
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

export interface FormQuestion {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
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

export class KoboClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(config: KoboClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiToken = config.apiToken;
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

  async getFormSummary(uid: string): Promise<FormSummary> {
    const data: {
      uid: string;
      name: string;
      deployment_status: string;
      deployment__submission_count: number | null;
      date_created: string;
      date_modified: string;
      date_deployed?: string | null;
      content?: {
        survey?: Array<{
          type: string;
          name?: string;
          $autoname?: string;
          label?: string[] | string;
          required?: boolean;
        }>;
      };
    } = await this.request(`/api/v2/assets/${encodeURIComponent(uid)}/`);

    const rawQuestions = data.content?.survey ?? [];
    const skipTypes = new Set(["start", "end", "note", "calculate"]);
    const questions: FormQuestion[] = rawQuestions
      .filter(
        (q) => !skipTypes.has(q.type) && !q.type.startsWith("group") && q.type !== "end_group" && q.type !== "end_repeat",
      )
      .map((q) => ({
        name: q.name ?? q.$autoname ?? "(unnamed)",
        type: q.type,
        label: Array.isArray(q.label) ? (q.label[0] ?? null) : (q.label ?? null),
        required: q.required === true,
      }));

    return {
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
    return data;
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

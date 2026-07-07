import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { KoboClient, KoboApiError } from "./kobo-client.js";

const BASE_URL = "https://kf.example.org";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

describe("KoboClient", () => {
  let fetchCalls: string[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  test("listForms follows pagination and maps fields", async () => {
    globalThis.fetch = mock.fn(async (input: string | URL) => {
      const url = input.toString();
      fetchCalls.push(url);
      if (fetchCalls.length === 1) {
        return jsonResponse({
          results: [
            {
              uid: "aAA",
              name: "Form A",
              asset_type: "survey",
              deployment_status: "deployed",
              deployment__submission_count: 5,
              date_modified: "2026-07-01T00:00:00Z",
              date_deployed: "2026-06-01T00:00:00Z",
              owner__username: "alice",
            },
          ],
          next: `${BASE_URL}/api/v2/assets/?asset_type=survey&limit=100&page=2`,
        });
      }
      return jsonResponse({
        results: [
          {
            uid: "bBB",
            name: "Form B",
            asset_type: "survey",
            deployment_status: "draft",
            deployment__submission_count: null,
            date_modified: "2026-07-02T00:00:00Z",
          },
        ],
        next: null,
      });
    }) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const forms = await client.listForms();

    assert.equal(fetchCalls.length, 2);
    assert.equal(forms.length, 2);
    assert.deepEqual(forms[0], {
      uid: "aAA",
      name: "Form A",
      assetType: "survey",
      deploymentStatus: "deployed",
      submissionCount: 5,
      dateModified: "2026-07-01T00:00:00Z",
      dateDeployed: "2026-06-01T00:00:00Z",
      owner: "alice",
    });
    assert.equal(forms[1].submissionCount, null);
    assert.equal(forms[1].owner, null);
  });

  test("getSubmissions serializes query/sort/fields as JSON params", async () => {
    let capturedUrl: URL | undefined;
    globalThis.fetch = mock.fn(async (input: string | URL) => {
      capturedUrl = new URL(input.toString());
      return jsonResponse({ count: 0, results: [] });
    }) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    await client.getSubmissions("formUid", {
      query: { "group/city": "Kigali" },
      sort: { _submission_time: -1 },
      fields: ["_id", "group/city"],
      start: 10,
      limit: 200, // should be clamped to 100
    });

    assert.ok(capturedUrl);
    assert.equal(capturedUrl!.searchParams.get("start"), "10");
    assert.equal(capturedUrl!.searchParams.get("limit"), "100");
    assert.equal(capturedUrl!.searchParams.get("query"), JSON.stringify({ "group/city": "Kigali" }));
    assert.equal(capturedUrl!.searchParams.get("sort"), JSON.stringify({ _submission_time: -1 }));
    assert.equal(capturedUrl!.searchParams.get("fields"), JSON.stringify(["_id", "group/city"]));
  });

  test("throws KoboApiError with status on non-retryable 4xx", async () => {
    const fetchMock = mock.fn(async () => jsonResponse({ detail: "Not found." }, 404));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    await assert.rejects(
      () => client.getFormSummary("missing"),
      (err: unknown) => {
        assert.ok(err instanceof KoboApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("retries on 503 then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ detail: "unavailable" }, 503);
      return jsonResponse({ count: 1, results: [{ _id: 1 }] });
    }) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const page = await client.getSubmissions("formUid");

    assert.equal(calls, 2);
    assert.equal(page.count, 1);
  });

  test("getManySubmissions stops at maxRows across pages", async () => {
    let calls = 0;
    globalThis.fetch = mock.fn(async (input: string | URL) => {
      calls += 1;
      const url = new URL(input.toString());
      const start = Number(url.searchParams.get("start"));
      const limit = Number(url.searchParams.get("limit"));
      const total = 25;
      const results = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({ _id: start + i }));
      return jsonResponse({ count: total, results });
    }) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const { rows, totalCount, truncated } = await client.getManySubmissions("formUid", { maxRows: 12 });

    assert.equal(rows.length, 12);
    assert.equal(totalCount, 25);
    assert.equal(truncated, true);
    assert.ok(calls >= 1);
  });

  test("getFormSummary parses content.survey into path-aware questions", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        uid: "formUid",
        name: "Household Survey",
        deployment_status: "deployed",
        deployment__submission_count: 3,
        date_created: "2026-01-01T00:00:00Z",
        date_modified: "2026-01-02T00:00:00Z",
        date_deployed: "2026-01-01T00:00:00Z",
        content: {
          survey: [
            { type: "text", name: "enumerator", required: true, label: ["Enumerator"] },
            { type: "begin_repeat", name: "members" },
            { type: "text", name: "member_name", required: true, label: ["Name"] },
            { type: "end_repeat" },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const summary = await client.getFormSummary("formUid");

    assert.equal(summary.questionCount, 2);
    assert.equal(summary.questions[0].path, "enumerator");
    assert.equal(summary.questions[0].repeatPath, null);
    assert.equal(summary.questions[1].path, "members/member_name");
    assert.equal(summary.questions[1].repeatPath, "members");
  });

  test("getFormSummary caches results and skips a second fetch within the TTL", async () => {
    const fetchMock = mock.fn(async () =>
      jsonResponse({
        uid: "formUid",
        name: "Form",
        deployment_status: "deployed",
        deployment__submission_count: 0,
        date_created: "2026-01-01T00:00:00Z",
        date_modified: "2026-01-01T00:00:00Z",
        content: { survey: [] },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok", formSummaryCacheTtlMs: 60_000 });
    await client.getFormSummary("formUid");
    await client.getFormSummary("formUid");

    assert.equal(fetchMock.mock.callCount(), 1);
  });

  test("getFormSummary bypasses the cache when skipCache is true", async () => {
    const fetchMock = mock.fn(async () =>
      jsonResponse({
        uid: "formUid",
        name: "Form",
        deployment_status: "deployed",
        deployment__submission_count: 0,
        date_created: "2026-01-01T00:00:00Z",
        date_modified: "2026-01-01T00:00:00Z",
        content: { survey: [] },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok", formSummaryCacheTtlMs: 60_000 });
    await client.getFormSummary("formUid");
    await client.getFormSummary("formUid", { skipCache: true });

    assert.equal(fetchMock.mock.callCount(), 2);
  });

  test("getSubmissionAttachments maps _attachments from a single submission", async () => {
    globalThis.fetch = mock.fn(async () =>
      jsonResponse({
        _id: 42,
        _attachments: [
          {
            id: 7,
            filename: "photo.jpg",
            mimetype: "image/jpeg",
            download_url: "https://kf.example.org/media/photo.jpg",
            download_small_url: "https://kf.example.org/media/photo-small.jpg",
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const attachments = await client.getSubmissionAttachments("formUid", 42);

    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, "photo.jpg");
    assert.equal(attachments[0].downloadUrl, "https://kf.example.org/media/photo.jpg");
    assert.equal(attachments[0].downloadSmallUrl, "https://kf.example.org/media/photo-small.jpg");
    assert.equal(attachments[0].downloadLargeUrl, null);
  });

  test("getSubmissionAttachments returns an empty array when there are no attachments", async () => {
    globalThis.fetch = mock.fn(async () => jsonResponse({ _id: 42 })) as unknown as typeof fetch;

    const client = new KoboClient({ baseUrl: BASE_URL, apiToken: "tok" });
    const attachments = await client.getSubmissionAttachments("formUid", 42);

    assert.deepEqual(attachments, []);
  });
});

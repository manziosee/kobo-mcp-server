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
});

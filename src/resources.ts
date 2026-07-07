import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KoboClient } from "./kobo-client.js";

export function registerResourcesAndPrompts(server: McpServer, client: KoboClient): void {
  server.registerResource(
    "kobo-form",
    new ResourceTemplate("kobo://forms/{uid}", {
      list: async () => {
        const forms = await client.listForms();
        return {
          resources: forms.map((f) => ({
            uri: `kobo://forms/${f.uid}`,
            name: f.name,
            description: `${f.deploymentStatus} · ${f.submissionCount ?? 0} submissions`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Kobo form",
      description:
        "A KoboToolbox form's metadata and question list (same data as get_form_summary), browsable as an MCP resource.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const uid = String(variables.uid);
      const summary = await client.getFormSummary(uid);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "weekly_submission_digest",
    {
      title: "Weekly submission digest",
      description:
        "Summarize a form's recent activity: submission volume trend, incomplete submissions, and validation review status.",
      argsSchema: {
        uid: z.string().describe("The form's uid, from list_forms"),
      },
    },
    ({ uid }: { uid: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Give me a weekly digest for Kobo form ${uid}. Use the kobo MCP tools to:\n` +
              `1. Call get_submission_stats with bucket "day" to show the submission trend over the last 7 days.\n` +
              `2. Call flag_incomplete_submissions to list any submissions missing required answers.\n` +
              `3. Call get_validation_summary to show how many submissions are approved vs. pending review.\n` +
              `Summarize the findings as a short report with counts and any notable issues to follow up on.`,
          },
        },
      ],
    }),
  );
}

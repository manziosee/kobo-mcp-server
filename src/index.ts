#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KoboClient } from "./kobo-client.js";
import { registerTools } from "./tools.js";
import { registerResourcesAndPrompts } from "./resources.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const apiToken = requireEnv("KOBO_API_TOKEN");
  const baseUrl = process.env.KOBO_BASE_URL || "https://kf.kobotoolbox.org";

  const client = new KoboClient({ baseUrl, apiToken });

  const server = new McpServer({
    name: "kobo-mcp-server",
    version: "0.1.0",
  });

  registerTools(server, client);
  registerResourcesAndPrompts(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("kobo-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting kobo-mcp-server:", error);
  process.exit(1);
});

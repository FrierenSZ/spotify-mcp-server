import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { readTools } from './read.js';

function buildServer() {
  const s = new McpServer({ name: 'spotify-controller', version: '1.0.0' });
  [...readTools, ...playTools, ...albumTools].forEach((tool) => {
    s.tool(tool.name, tool.description, tool.schema, tool.handler);
  });
  return s;
}

async function main() {
  if (process.env.MCP_TRANSPORT === 'http') {
    const port = Number(process.env.PORT ?? 8000);
    const httpServer = createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await buildServer().connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServer.listen(port, () => {
      console.error(`MCP HTTP server listening on :${port}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
  }
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});

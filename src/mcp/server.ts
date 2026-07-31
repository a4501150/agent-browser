import * as z from 'zod';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { version } from '../../package.json';
import { allTools } from './registry';
import { callTool } from './dispatch';

import type { ServerHost } from './host';

export const serverInfo = { name: 'agent-browser', version };

export function createServer(host: ServerHost): Server {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(tool => ({
      name: tool.schema.name,
      title: tool.schema.title,
      description: tool.schema.description,
      inputSchema: z.toJSONSchema(tool.schema.inputSchema, { io: 'input', target: 'draft-7' }) as any,
      annotations: {
        title: tool.schema.title,
        readOnlyHint: tool.schema.type === 'readOnly',
        // destructiveHint is deliberately omitted: it defaults to true, and
        // claiming false for tools that can close a browser, clear cookies or
        // run arbitrary page script would be a lie.
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callTool(host, request.params.name, request.params.arguments ?? {}, extra?.signal));

  return server;
}

import * as z from 'zod';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { allTools } from './registry';
import { callTool } from './dispatch';

import type { ServerHost } from './host';

export const serverInfo = { name: 'agent-browser', version: '0.1.0' };

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
        destructiveHint: false,
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callTool(host, request.params.name, request.params.arguments ?? {}, extra?.signal));

  return server;
}

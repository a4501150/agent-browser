/**
 * Derived from playwright-core/src/tools/backend/browserBackend.ts (Apache-2.0,
 * tag v1.62.1), dispatching against our instance registry instead of one
 * implicit context.
 */
import * as z from 'zod';

import { findTool } from './registry';
import { Response } from './response';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerHost } from './host';

export async function callTool(
  host: ServerHost,
  name: string,
  rawArguments: Record<string, any> = {},
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const tool = findTool(name);
  if (!tool)
    return formatError(`Tool "${name}" not found.`);

  let params: any;
  try {
    params = tool.schema.inputSchema.parse(rawArguments);
  } catch (error) {
    if (error instanceof z.ZodError)
      return formatError(`Invalid arguments for tool "${name}":\n${z.prettifyError(error)}`);
    throw error;
  }

  let target: any = host;
  if (tool.kind !== 'global') {
    try {
      target = host.instances.get(params.instance_id);
    } catch (error: any) {
      return formatError(String(error?.message ?? error));
    }
  }

  // A tab tool renders against its instance's tabs; a global tool has none.
  const response = new Response(tool.kind === 'global' ? host : target, name);
  try {
    await tool.handle(target, params, response, signal);
    return await response.serialize();
  } catch (error: any) {
    return formatError(String(error?.stack ?? error?.message ?? error));
  }
}

function formatError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `### Error\n${message}` }], isError: true };
}

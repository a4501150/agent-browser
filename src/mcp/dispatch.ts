/**
 * Derived from playwright-core/src/tools/backend/browserBackend.ts (Apache-2.0,
 * tag v1.62.1), dispatching against our instance registry instead of one
 * implicit context.
 */
import debug from 'debug';
import * as z from 'zod';

import { findTool } from './registry';
import { Response } from './response';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerHost } from './host';

const log = debug('agent-browser:tool');

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
    params = tool.schema.inputSchema.parse(withoutNulls(tool.schema.inputSchema, rawArguments));
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
    // The stack names server-side paths, which belong in the log rather than in
    // a result an untrusted page may end up influencing.
    log('%s failed: %s', name, error?.stack ?? error);
    return formatError(String(error?.message ?? error));
  }
}

/**
 * Drop optional fields that arrived as an explicit null.
 *
 * A client running OpenAI's strict schema subset has to list every property in
 * `required` and can only express "omitted" as a nullable union, so `checked`,
 * `url` and every other optional field reaches us as null rather than absent.
 * A field that accepts null itself keeps it, because there the distinction is
 * the point: browser_open's `profile` means "throwaway profile".
 */
function withoutNulls(schema: z.ZodObject, rawArguments: Record<string, any>): Record<string, any> {
  const shape = schema.shape as Record<string, z.ZodType | undefined>;
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawArguments)) {
    if (value === null && !shape[key]?.safeParse(null).success)
      continue;
    result[key] = value;
  }
  return result;
}

function formatError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `### Error\n${message}` }], isError: true };
}

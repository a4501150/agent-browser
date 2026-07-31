import instances from '../tools/instances';
import navigate from '../tools/navigate';
import perception from '../tools/perception';
import interaction from '../tools/interaction';
import modal from '../tools/modal';
import script from '../tools/script';
import tabs from '../tools/tabs';
import observe from '../tools/observe';
import coordinates from '../tools/coordinates';
import state from '../tools/state';
import window from '../tools/window';
import web from '../tools/web';

import type { ToolDefinition } from './tool';

/** All 32 tools, always on. There is no capability system to configure. */
export const allTools: ToolDefinition[] = [
  ...instances,
  ...navigate,
  ...perception,
  ...interaction,
  ...modal,
  ...script,
  ...tabs,
  ...observe,
  ...coordinates,
  ...state,
  ...window,
  ...web,
];

const byName = new Map(allTools.map(tool => [tool.schema.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

if (byName.size !== allTools.length) {
  const seen = new Set<string>();
  const duplicates = allTools.map(t => t.schema.name).filter(n => seen.size === seen.add(n).size);
  throw new Error(`Duplicate tool names: ${[...new Set(duplicates)].join(', ')}`);
}

/**
 * `InitializeResult.instructions`. A client injects this into every conversation
 * the server is connected to and re-sends it with the transcript every turn
 * after that, so length is paid repeatedly rather than once — keep it short,
 * and keep it to things no single tool description can teach. Anything about
 * one tool belongs in that tool's `description` instead.
 */
export const instructions = `agent-browser drives a patched Chromium that is not detectable as automation and reaches every frame of a page, cross-origin iframes included.

Two tiers of tool, and picking the wrong one is the common mistake. \`web_search\`, \`web_fetch\`, \`web_crawl\` and \`web_extract\` take no \`instance_id\` and run in a throwaway profile, so research traffic never touches a logged-in one — reach for these first when you only need to read. Every \`browser_*\` tool takes an \`instance_id\` from \`browser_open\`; use those when you must interact, log in, or see what exists only after interaction.

To see a page use \`browser_read_page\`, not \`browser_screenshot\`. It returns an accessibility outline with \`[ref=eN]\` handles that every action tool accepts, 10-50x smaller than the HTML, and \`browser_find\` searches that outline when you only need one element. Screenshot when appearance itself is the question. A ref from a stale snapshot fails with an error saying so.

An instance lives as long as your session: nothing is idle-reaped unless the server was started with \`--idle-timeout\`. Open one and keep using it rather than re-opening per step, and do not close one you may want again — tabs, cookies, scroll position and half-finished logins all survive, however long you spend on other tools in between. An \`instance_id\` is scoped to this server process.

A named profile persists across sessions, so a login done once is there next time. If another session already holds that name you silently get an ephemeral clone, and everything written to it, a login included, is discarded on close; concurrent work that must persist needs distinct profile names.

Limits are yours to choose — ask for the \`count\`, \`max_pages\` or \`timeout\` you actually want. Nothing is silently clamped.`;

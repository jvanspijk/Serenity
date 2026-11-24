const pageSize = 8;
const maxNames = 8;
const maxQueryLength = 200;

export function createMcpDiscovery(connections, activeTools) {
  const catalog = new Map();
  for (const { server, session } of connections) {
    for (const tool of session.tools) {
      const name = 'mcp_' + catalog.size + '_' + tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
      catalog.set(name, {
        server,
        label: server + ' · ' + tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.inputSchema,
        run: args => session.callTool(tool.name, args)
      });
    }
  }
  if (!catalog.size) return;

  return {
    name: 'mcp_discover',
    label: 'Discover MCP tools',
    description: 'Find tools from enabled MCP connections. Search by keywords or browse, then pass exact result names in load to make those tools callable on the next round.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: maxQueryLength, description: 'Keywords for tool names, descriptions, or server names. Omit to browse all tools.' },
        offset: { type: 'integer', minimum: 0, description: 'Use next_offset to continue the same search.' },
        load: { type: 'array', minItems: 1, maxItems: maxNames, items: { type: 'string', maxLength: 64 }, description: 'Exact result names to load. Omit query and offset when loading.' }
      },
      additionalProperties: false
    },
    run({ query, offset, load }) {
      if (load !== undefined) {
        if (query !== undefined || offset !== undefined || !Array.isArray(load) || !load.length || load.length > maxNames ||
            load.some(name => typeof name !== 'string' || name.length > 64)) {
          return { isError: true, error: 'Provide one to eight tool names in load by itself.' };
        }
        const loaded = [];
        const unavailable = [];
        for (const name of new Set(load)) {
          const tool = catalog.get(name);
          if (tool) {
            activeTools.set(name, tool);
            loaded.push(name);
          } else unavailable.push(name);
        }
        return { loaded, ...(unavailable.length && { unavailable }), ...(!loaded.length && { isError: true }) };
      }

      if ((query !== undefined && (typeof query !== 'string' || query.length > maxQueryLength)) ||
          (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))) {
        return { isError: true, error: 'Use a query of up to 200 characters and a nonnegative offset.' };
      }
      const start = offset ?? 0;
      const terms = [...new Set(query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
      const matches = [];
      for (const [name, tool] of catalog) {
        const label = (name + ' ' + tool.label).toLowerCase();
        const description = tool.description.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (label.includes(term) ? 2 : description.includes(term) ? 1 : 0), 0);
        if (score || !terms.length) matches.push({ name, tool, score });
      }
      matches.sort((a, b) => b.score - a.score);
      const end = start + pageSize;
      return {
        matches: matches.slice(start, end).map(({ name, tool }) => ({
          name, server: tool.server, description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 200)
        })),
        ...(end < matches.length && { next_offset: end })
      };
    }
  };
}

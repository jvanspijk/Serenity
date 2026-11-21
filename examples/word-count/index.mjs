export async function run(tool, args) {
  if (tool !== 'count' || typeof args.text !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Expected text.' }] };
  }
  const words = args.text.trim().match(/\S+/g)?.length || 0;
  return { content: [{ type: 'text', text: JSON.stringify({ words, characters: args.text.length }) }] };
}

import { pathToFileURL } from 'node:url';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 64 * 1024) throw new Error('Input too large');
}
const { run } = await import(pathToFileURL(process.argv[2]).href);
if (typeof run !== 'function') throw new Error('Plugin must export run');
const result = await run(process.argv[3], JSON.parse(input));
if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Plugin must return an object');
process.stdout.write(JSON.stringify(result));

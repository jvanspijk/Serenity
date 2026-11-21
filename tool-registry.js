import { readFile } from 'node:fs/promises';
import { webLookup } from './tools/web-lookup.js';

const webLookupSkill = (await readFile(new URL('./skills/web-lookup/SKILL.md', import.meta.url), 'utf8')).trim();

export const builtInTools = [
  { id: 'webSearch', label: 'Web tools', tools: [webLookup], systemPrompt: webLookupSkill }
];

import { readFile } from 'node:fs/promises';
import { webLookup } from './tools/web-lookup.js';
import { imageTools } from './tools/workspace-image.js';
import { audioTools } from './tools/workspace-audio.js';

const webLookupSkill = (await readFile(new URL('./skills/web-lookup/SKILL.md', import.meta.url), 'utf8')).trim();

export const builtInTools = [
  { id: 'webSearch', label: 'Web tools', tools: [webLookup], systemPrompt: webLookupSkill },
  { id: 'workspaceImage', label: 'Image tools', description: 'Crop, zoom, and rotate workspace images', mediaKind: 'image', tools: imageTools },
  { id: 'workspaceAudio', label: 'Audio tools', description: 'Trim, stretch, and clean up workspace audio', mediaKind: 'audio', tools: audioTools }
];

import { WorkspaceMediaError } from './media-source.js';
import { workspaceRenderers } from '../workspace-media.js';

export function createShowView(media, present) {
  const types = Array.from(media.values(), item => item.presentLabel).join(' or ');
  return {
    name: 'show_view',
    label: 'Show view',
    description: 'Displays ' + types + ' inline in the chat for the user and returns only a confirmation. ' +
      'Accepts an original attachment or an edited workspace view. Use read_file to inspect the media yourself.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace attachment path or a view path returned by an edit tool.' },
        chunk: { type: 'integer', minimum: 1, description: 'Page or clip number starting at 1 for files stored in chunks.' },
        label: { type: 'string', maxLength: 160, description: 'Short description for the user, including screen reader users.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run({ path, chunk, label }, signal, workspace) {
      if (label !== undefined && (typeof label !== 'string' || label.length > 160)) {
        throw new WorkspaceMediaError('Use a view label of up to 160 characters.');
      }
      const source = await workspace.input(path, { chunk });
      if (!workspaceRenderers.has(source.kind)) {
        throw new WorkspaceMediaError('Choose an image, PDF page, or audio clip.');
      }
      signal.throwIfAborted();
      present({ path: source.reference, kind: source.kind, label: label?.trim() });
      return { path: source.reference, presented: true, ...(source.warning && { warning: source.warning }) };
    }
  };
}

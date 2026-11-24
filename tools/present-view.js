import { ignoredChunkWarning, WorkspaceMediaError } from './media-source.js';

export function createPresentView(mediaKinds, present) {
  const types = [
    mediaKinds.has('image') && 'an image or PDF page',
    mediaKinds.has('audio') && 'an audio clip with playback controls'
  ].filter(Boolean).join(' or ');
  return {
    name: 'present_view',
    label: 'Present view',
    description: 'Shows ' + types + ' inline in the chat for the user. Accepts an original attachment or an edited workspace view.',
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
      if (source.kind !== 'image' && source.kind !== 'audio') {
        throw new WorkspaceMediaError('Choose an image, PDF page, or audio clip.');
      }
      signal.throwIfAborted();
      present({ path: source.reference, kind: source.kind, label: label?.trim() });
      return { path: source.reference, presented: true, ...(chunk !== undefined && !source.chunked && { warning: ignoredChunkWarning }) };
    }
  };
}

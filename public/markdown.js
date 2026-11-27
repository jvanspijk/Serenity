import MarkdownIt from './markdown-it.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true });
markdown.validateLink = url => /^https?:\/\//i.test(url);

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

// Keep the description without fetching images referenced by assistant output.
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const alt = renderer.renderInlineAsText(tokens[index].children, options, env);
  return markdown.utils.escapeHtml(alt || 'Image');
};

markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

for (const rule of ['th_open', 'td_open']) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    const style = token.attrIndex('style');
    if (style !== -1) {
      // The app's Content Security Policy disallows inline styles.
      const alignment = token.attrs[style][1].slice('text-align:'.length);
      token.attrs[style] = ['class', 'align-' + alignment];
    }
    return renderer.renderToken(tokens, index, options);
  };
}

export function renderMarkdown(text) {
  return markdown.render(text).trim();
}

export function streamMarkdown(target) {
  const boundary = document.createComment('');
  const range = document.createRange();
  target.replaceChildren(boundary);
  target.classList.add('markdown');
  let offset = 0;

  return text => {
    const tail = text.slice(offset);
    const lines = tail.split(/(?<=\n)|(?<=\r)(?!\n)/);
    const env = {};
    const tokens = markdown.parse(tail, env);
    // Keep the last block reparsable. An unfinished line can change where it starts.
    const split = Math.max(0, tokens.findLastIndex(token => token.level === 0 && token.map?.[0] < lines.length - 1));

    range.setStartAfter(boundary);
    range.setEnd(target, target.childNodes.length);
    range.deleteContents();
    if (split > 0) {
      const html = markdown.renderer.render(tokens.slice(0, split), markdown.options, env);
      boundary.before(range.createContextualFragment(html));
      offset += lines.slice(0, tokens[split].map[0]).join('').length;
    }
    target.insertAdjacentHTML('beforeend', markdown.renderer.render(tokens.slice(split), markdown.options, env));
  };
}

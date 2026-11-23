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

export function updateMarkdown(target, text) {
  const template = document.createElement('template');
  template.innerHTML = markdown.render(text).trim();

  // Later lines can change earlier Markdown, for example by defining a reference link.
  // Reparse the full text while keeping matching elements and growing text in place.
  updateChildren(target, template.content);
}

function updateChildren(target, source) {
  let current = target.firstChild;
  for (const next of [...source.childNodes]) {
    if (!current) {
      target.append(next);
      continue;
    }
    const sibling = current.nextSibling;
    if (!current.isEqualNode(next)) {
      if (current.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) {
        current.data = next.data;
      } else if (current.nodeType === Node.ELEMENT_NODE && current.nodeName === next.nodeName &&
        current.attributes.length === next.attributes.length &&
        next.getAttributeNames().every(name => current.getAttribute(name) === next.getAttribute(name))) {
        updateChildren(current, next);
      } else {
        current.replaceWith(next);
      }
    }
    current = sibling;
  }
  while (current) {
    const sibling = current.nextSibling;
    current.remove();
    current = sibling;
  }
}

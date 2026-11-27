export function initializeSettings({ dialog, api, element, iconButton, toggleRow, workspaceAccess, onChange, onSave, onError }) {
  const $ = id => dialog.querySelector('#' + id);
  const connectionFields = new Map();
  let mcpCheck = 0;

  function settingError(message = '') {
    $('settings-error').textContent = message;
    if (message) $('settings-error').scrollIntoView({ block: 'nearest' });
  }

  function field(label, type, value, placeholder, required = false) {
    const wrapper = element('label', '', label);
    const input = element('input');
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.required = required;
    input.spellcheck = false;
    input.autocomplete = 'off';
    wrapper.append(input);
    return { wrapper, input };
  }

  function addConnection(connection = {}) {
    const card = element('div', 'connection');
    const head = element('div', 'connection-head');
    const badge = element('span');
    const remove = iconButton('trash', 'Remove MCP connection');
    remove.addEventListener('click', () => {
      connectionFields.delete(card);
      card.remove();
    });
    head.append(badge, remove);
    const name = field('Name', 'text', connection.name || '', 'Local tools', true);
    const url = field('Streamable HTTP URL', 'url', connection.url || '', 'http://host.docker.internal:8000/mcp', true);
    const key = field('Bearer token', 'password', '', connection.hasToken ? 'Saved' : 'Optional');
    const defaultToggle = toggleRow('On by default in new chats', connection.enabledByDefault);
    card.append(head, name.wrapper, url.wrapper, key.wrapper, defaultToggle.row);
    $('connections').append(card);
    connectionFields.set(card, { id: connection.id, badge, name: name.input, url: url.input, key: key.input, defaultToggle: defaultToggle.input });
    badge.textContent = connection.id ? 'Checking…' : 'Unsaved';
    return name.input;
  }

  async function checkMcp() {
    const request = ++mcpCheck;
    const entries = [...connectionFields.values()].filter(entry => entry.id);
    if (!entries.length) return;
    $('check-mcp').disabled = true;
    for (const entry of entries) entry.badge.textContent = 'Checking…';
    try {
      const statuses = await api('mcp');
      if (request !== mcpCheck) return;
      for (const { id, badge } of entries) {
        const health = statuses.find(server => server.id === id);
        badge.replaceChildren(element('i', 'dot ' + (health?.online ? 'online' : 'offline')),
          document.createTextNode(health?.online ? 'Online · ' + health.count + (health.count === 1 ? ' tool' : ' tools') : 'Offline'));
      }
    } catch {
      if (request === mcpCheck) for (const { badge } of entries) badge.textContent = 'Could not check connection';
    } finally {
      if (request === mcpCheck) $('check-mcp').disabled = false;
    }
  }

  function applySettings(config) {
    const root = document.documentElement;
    root.dataset.chatTextSize = config.chatTextSize;
    root.dataset.colorPalette = config.colorPalette;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--surface-subtle').trim();
    onChange(config);
  }

  async function openSettings() {
    try {
      const config = await api('settings');
      if (dialog.open) return;
      applySettings(config);
      $('endpoint').value = config.endpoint;
      $('api-key').value = '';
      $('api-key').placeholder = config.hasToken ? 'Saved' : 'Optional';
      $('system-prompt').value = config.systemPrompt;
      $('show-inference-stats').checked = config.showInferenceStats;
      $('chat-text-size').value = config.chatTextSize;
      $('color-palette').value = config.colorPalette;
      $('follow-up-behavior').value = config.followUpBehavior;
      $('share-timezone').checked = config.shareTimezone;
      $('tool-call-limit').value = config.toolCallLimit;
      $('tool-defaults').replaceChildren(...config.tools.map(({ id, label, description, permissions, enabledByDefault }) => {
        const { row, input } = toggleRow('', enabledByDefault);
        const name = element('span', 'tool-setting-name', label);
        const details = [description, workspaceAccess(permissions)].filter(Boolean).join(' · ');
        name.id = 'tool-name-' + id;
        input.value = id;
        input.setAttribute('aria-labelledby', name.id);
        const copy = element('span');
        copy.append(name);
        if (details) {
          const descriptionNode = element('span', 'tool-setting-description', details);
          descriptionNode.id = 'tool-description-' + id;
          input.setAttribute('aria-describedby', descriptionNode.id);
          copy.append(descriptionNode);
        }
        row.classList.add('tool-setting');
        row.prepend(copy);
        return row;
      }));
      $('connections').replaceChildren();
      connectionFields.clear();
      for (const connection of config.mcp) addConnection(connection);
      settingError();
      dialog.showModal();
      checkMcp();
    } catch (error) { onError(error.message); }
  }

  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const save = $('save-settings');
    if (save.disabled) return;
    save.disabled = true;
    settingError();
    const token = $('api-key').value;
    try {
      const config = await api('settings', 'PUT', {
        endpoint: $('endpoint').value.trim(),
        ...(token && { token }),
        systemPrompt: $('system-prompt').value,
        showInferenceStats: $('show-inference-stats').checked,
        chatTextSize: $('chat-text-size').value,
        colorPalette: $('color-palette').value,
        followUpBehavior: $('follow-up-behavior').value,
        shareTimezone: $('share-timezone').checked,
        toolCallLimit: $('tool-call-limit').value,
        toolDefaults: Array.from($('tool-defaults').querySelectorAll('input:checked'), input => input.value),
        mcp: [...connectionFields.values()].map(({ id, name, url, key, defaultToggle }) => ({
          id, name: name.value, url: url.value.trim(), enabledByDefault: defaultToggle.checked,
          ...(key.value && { token: key.value })
        }))
      });
      applySettings(config);
      dialog.close();
      await onSave();
    } catch (error) { settingError(error.message); }
    finally { save.disabled = false; }
  });

  document.querySelectorAll('[data-open-settings]').forEach(button => button.addEventListener('click', openSettings));
  dialog.querySelectorAll('[data-close-settings]').forEach(button => button.addEventListener('click', () => dialog.close()));
  $('add-mcp').addEventListener('click', () => {
    if (connectionFields.size < 12) addConnection().focus();
    else settingError('You can add up to 12 connections.');
  });
  $('check-mcp').addEventListener('click', checkMcp);

  api('settings').then(applySettings).catch(error => onError(error.message));
}

import { updateMarkdown } from './markdown.js';
import { sse } from './protocol.js';

const $ = id => document.getElementById(id);
const state = {
  chat: null, list: [], models: [], modelState: 'loading', settings: null,
  attachments: [], busy: false, draftTools: null, savingTools: false, deleting: false
};
const ns = 'http://www.w3.org/2000/svg';
const chatLocked = () => state.busy || state.savingTools || state.deleting;
const selectionModifier = event => event.metaKey || event.ctrlKey;
const selectedChats = new Set();
let selectionAnchor;
let clickedChat;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '/icons.svg#' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function iconButton(name, label, className = 'icon') {
  const button = element('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}

async function request(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, {
    method,
    ...(data !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not reach Serenity.');
  return response;
}

const api = async (...args) => (await request(...args)).json();

function status(message = '') {
  $('status').textContent = message;
  $('status').hidden = !message;
}

function renderControls() {
  const hasModel = state.modelState === 'online' && Boolean($('models').value);
  $('send').disabled = state.busy ? !state.streamId || Boolean(state.stopping) :
    chatLocked() || !hasModel || (!$('prompt').value.trim() && !state.attachments.length);
  const label = state.busy ? 'Stop reply' : 'Send message';
  $('send').title = label;
  $('send').setAttribute('aria-label', label);
  $('send').replaceChildren(icon(state.busy ? 'stop' : 'send'));
  $('models').disabled = state.busy || state.modelState !== 'online';
  $('model-notice').hidden = !['offline', 'empty'].includes(state.modelState);
  $('history').querySelectorAll('.history-item button').forEach(button => {
    button.disabled = chatLocked();
  });
  $('delete-selected').disabled = chatLocked();
  $('new-chat').disabled = chatLocked();
  $('attach').disabled = state.busy;
  $('prompt').readOnly = state.busy;
  $('tools-button').disabled = state.busy || !state.settings;
  $('tool-options').disabled = chatLocked();
  $('thread').querySelectorAll('.reply-issue button').forEach(button => {
    button.disabled = !hasModel || chatLocked();
  });
}

function selectedTools() {
  if (state.chat) return state.chat.tools;
  return state.draftTools || {
    builtIn: state.settings?.tools.filter(tool => tool.enabledByDefault).map(tool => tool.id) || [],
    mcp: state.settings?.mcp.filter(server => server.enabledByDefault).map(server => server.id) || []
  };
}

function setToolsOpen(open) {
  $('tools-panel').hidden = !open;
  $('tools-button').setAttribute('aria-expanded', String(open));
}

function toggleRow(label, checked) {
  const row = element('label', 'toggle-row', label);
  const input = element('input', 'toggle');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = checked;
  row.append(input);
  return { row, input };
}

function syncTools() {
  const selected = selectedTools();
  const switches = [...$('tool-switches').querySelectorAll('input')];
  for (const input of switches) {
    input.checked = selected[input.dataset.group].includes(input.value);
  }
  $('tools-button').classList.toggle('is-active', switches.some(input => input.checked));
}

function workspaceAccess(permissions) {
  if (permissions?.workspaceWrite) return 'Workspace read and write';
  if (permissions?.workspaceRead) return 'Workspace read';
  return '';
}

function renderTools() {
  const entries = [
    ...state.settings.tools.map(({ id, label, permissions }) => ({
      id, label: [label, workspaceAccess(permissions)].filter(Boolean).join(' · '), group: 'builtIn'
    })),
    ...state.settings.mcp.map(({ id, name }) => ({ id, label: name, group: 'mcp' }))
  ];
  $('tool-switches').replaceChildren(...entries.map(({ id, label, group }) => {
    const { row, input } = toggleRow(label, false);
    input.value = id;
    input.dataset.group = group;
    input.addEventListener('change', () => setChatTool(input));
    return row;
  }));
  syncTools();
}

async function setChatTool(input) {
  const { value: id, checked, dataset: { group } } = input;
  const current = selectedTools();
  const selection = {
    ...current, [group]: checked ? [...current[group], id] : current[group].filter(key => key !== id)
  };
  if (!state.chat) {
    state.draftTools = selection;
    syncTools();
    return;
  }
  const chat = state.chat;
  state.savingTools = true;
  renderControls();
  try {
    chat.tools = await api('chats/' + chat.id + '/tools', 'PUT', selection);
  } catch (error) {
    status(error.message);
  } finally {
    state.savingTools = false;
    syncTools();
    renderControls();
    if (!$('tools-panel').hidden) input.focus();
  }
}

function renderModels(preferred) {
  const select = $('models');
  const selected = preferred || select.value;
  const { modelState, models } = state;
  const placeholder = { offline: 'Models unavailable', loading: 'Checking models…', empty: 'No models found' };
  select.replaceChildren(...(modelState === 'online' ? models.map(model => new Option(model, model)) :
    [new Option(placeholder[modelState], '')]));
  if (models.includes(selected) && modelState === 'online') select.value = selected;
  renderControls();
}

const modelRefreshCooldown = 5000;
let lastModelCheck = -Infinity;
let modelRequest = 0;
async function refreshModels() {
  const request = ++modelRequest;
  const retry = $('retry-models');
  retry.disabled = true;
  try {
    const list = await api('models');
    if (request !== modelRequest) return;
    if (state.modelState === 'online' && list.length === state.models.length &&
        list.every((model, index) => model === state.models[index])) return;
    state.models = list;
    state.modelState = list.length ? 'online' : 'empty';
    $('model-error').textContent = 'No models reported by the inference server.';
  } catch (error) {
    if (request !== modelRequest) return;
    if (state.modelState === 'online') return;
    state.modelState = 'offline';
    $('model-error').textContent = error.message;
  } finally {
    if (request === modelRequest) {
      lastModelCheck = performance.now();
      retry.disabled = false;
    }
  }
  renderModels($('models').value || state.chat?.model);
}

function refreshModelsOnReturn() {
  if (document.hidden || $('retry-models').disabled || performance.now() - lastModelCheck < modelRefreshCooldown) return;
  refreshModels();
}

function renderHistorySelection() {
  const button = $('delete-selected');
  button.hidden = !selectedChats.size;
  button.textContent = 'Delete (' + selectedChats.size + ')';
  button.setAttribute('aria-label', 'Delete ' + selectedChats.size + ' selected ' +
    (selectedChats.size === 1 ? 'conversation' : 'conversations'));
  $('history').querySelectorAll('.history-row').forEach(row => {
    if (selectedChats.size) row.setAttribute('aria-pressed', selectedChats.has(row.dataset.id));
    else row.removeAttribute('aria-pressed');
  });
}

function selectRange(id, fallback, additive) {
  const end = state.list.findIndex(chat => chat.id === id);
  let start = state.list.findIndex(chat => chat.id === selectionAnchor);
  if (start < 0) {
    start = state.list.findIndex(chat => chat.id === fallback);
    if (start < 0) start = end;
    selectionAnchor = state.list[start].id;
  }
  clickedChat = null;
  if (!additive) selectedChats.clear();
  for (let i = Math.min(start, end); i <= Math.max(start, end); i++) selectedChats.add(state.list[i].id);
  renderHistorySelection();
}

function chatsForDeletion(id) {
  return state.list.filter(chat => selectedChats.has(id) ? selectedChats.has(chat.id) : chat.id === id);
}

function renderHistory() {
  const nav = $('history');
  const focusedId = document.activeElement?.dataset.id;
  if (!state.list.length) {
    nav.replaceChildren(element('p', 'history-empty', 'No conversations yet'));
    renderHistorySelection();
    return;
  }
  nav.replaceChildren(...state.list.map(chat => {
    const item = element('div', 'history-item');
    const row = element('button', 'history-row');
    row.type = 'button';
    row.title = chat.title;
    row.dataset.id = chat.id;
    row.disabled = chatLocked();
    if (chat.id === state.chat?.id) row.setAttribute('aria-current', 'true');
    row.append(icon('chat'), element('span', '', chat.title));
    row.addEventListener('click', event => {
      row.focus({ preventScroll: true });
      if (event.shiftKey) {
        selectRange(chat.id, state.chat?.id, selectionModifier(event));
        return;
      }
      selectionAnchor = chat.id;
      if (selectionModifier(event)) {
        if (clickedChat) selectedChats.add(clickedChat);
        clickedChat = null;
        if (!selectedChats.delete(chat.id)) selectedChats.add(chat.id);
        renderHistorySelection();
        return;
      }
      clickedChat = chat.id;
      selectedChats.clear();
      renderHistorySelection();
      openChat(chat.id);
    });

    const actions = iconButton('more', 'Actions for ' + chat.title, 'icon history-actions');
    const menu = element('div', 'history-menu');
    menu.setAttribute('popover', 'auto');
    actions.popoverTargetElement = menu;
    actions.disabled = row.disabled;
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const count = chatsForDeletion(chat.id).length;
      removeLabel.textContent = count > 1 ? 'Delete ' + count + ' conversations' : 'Delete';
      const { top, right, bottom } = actions.getBoundingClientRect();
      const above = document.documentElement.clientHeight - bottom < 64;
      menu.classList.toggle('above', above);
      menu.style.setProperty('--menu-top', (above ? top - 4 : bottom + 4) + 'px');
      menu.style.setProperty('--menu-right', (document.documentElement.clientWidth - right) + 'px');
    });

    const remove = element('button', 'history-delete');
    remove.type = 'button';
    remove.autofocus = true;
    remove.disabled = row.disabled;
    const removeLabel = element('span', '', 'Delete');
    remove.append(icon('trash'), removeLabel);
    remove.addEventListener('click', () => {
      menu.hidePopover();
      actions.focus();
      askToDelete(chatsForDeletion(chat.id));
    });
    menu.append(remove);
    item.append(row, actions, menu);
    return item;
  }));
  renderHistorySelection();
  if (focusedId) {
    const row = [...nav.querySelectorAll('.history-row')].find(row => row.dataset.id === focusedId);
    row?.focus({ preventScroll: true });
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Try the selection-based fallback if the Clipboard API is blocked.
    }
  }

  const previousFocus = document.activeElement;
  const field = element('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

function makeMessage(message, options = {}) {
  const article = element('article', 'message ' + message.role);
  const copyLabel = message.role === 'user' ? 'Copy message' : 'Copy reply';
  const copy = iconButton('copy', copyLabel, 'icon copy');
  const clipboardError = 'Clipboard unavailable. Select the message text to copy it.';
  let copyReset;
  copy.addEventListener('click', async () => {
    if (!await copyText(message.content)) {
      status(clipboardError);
      return;
    }
    if ($('status').textContent === clipboardError) status();
    clearTimeout(copyReset);
    copy.replaceChildren(icon('check'));
    copy.setAttribute('aria-label', copyLabel + ' (copied)');
    copyReset = setTimeout(() => {
      copy.replaceChildren(icon('copy'));
      copy.setAttribute('aria-label', copyLabel);
    }, 3000);
  });
  if (message.role === 'user') {
    const bubble = element('div', 'user-bubble');
    if (message.images?.length) {
      const images = element('div', 'message-images');
      for (const image of message.images) {
        const img = element('img');
        img.alt = image.name;
        img.src = image.url;
        images.append(img);
      }
      bubble.append(images);
    }
    if (message.files?.length) {
      const files = element('div', 'message-files');
      for (const file of message.files) files.append(element('span', 'file-name', file.name));
      bubble.append(files);
    }
    bubble.append(element('div', 'message-text', message.content));
    article.append(bubble);
    if (message.content) article.append(copy);
    return { article };
  }
  const label = element('div', 'answer-head');
  label.append(icon('logo'), element('span', '', message.model || 'Assistant'));
  const details = element('details', 'reasoning');
  const reasoning = element('div', 'reasoning-text', message.reasoning);
  details.append(element('summary', '', 'Reasoning'), reasoning);
  const body = element('div', 'message-text markdown');
  const pending = element('div', 'pending', 'Waiting for model…');
  const issue = element('div', 'reply-issue');
  article.append(label, details, body, pending, issue, copy);
  let renderedLength = 0;
  function update(streaming, activity = '') {
    details.hidden = !message.reasoning;
    reasoning.textContent = message.reasoning;
    if (message.content.length !== renderedLength) {
      updateMarkdown(body, message.content);
      renderedLength = message.content.length;
    }
    pending.hidden = !streaming || Boolean(body.firstChild && !activity);
    pending.textContent = activity || (message.content ? 'Writing reply…' :
      message.reasoning ? 'Thinking…' : 'Waiting for model…');
    issue.hidden = streaming || !message.issue;
    copy.hidden = streaming || !message.content;
    if (!issue.hidden) {
      issue.replaceChildren(element('span', '', message.issue));
      if (options.canRetry) {
        const retry = element('button', '', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => submit(true));
        issue.append(retry);
      }
    }
  }
  update(Boolean(options.streaming));
  return { article, update };
}

function scrollDown() { $('stage').scrollTop = $('stage').scrollHeight; }
function nearBottom() {
  const stage = $('stage');
  return stage.scrollHeight - stage.scrollTop - stage.clientHeight < 100;
}

const tokenCount = new Intl.NumberFormat();
const tokenRate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function renderStats() {
  const footer = $('chat-stats');
  const messages = state.chat?.messages ?? [];
  footer.hidden = !state.settings?.showInferenceStats || !messages.some(message => message.role === 'assistant');
  if (footer.hidden) return;
  const totals = {};
  for (const { stats } of messages) {
    for (const [key, value] of Object.entries(stats ?? {})) totals[key] = (totals[key] ?? 0) + value;
  }
  $('input-tokens').textContent = totals.input == null ? '—' : tokenCount.format(totals.input);
  $('output-tokens').textContent = totals.output == null ? '—' : tokenCount.format(totals.output);
  $('token-rate').textContent = totals.generationMs ? tokenRate.format(totals.timedTokens * 1000 / totals.generationMs) : '—';
}

function renderThread() {
  const messages = state.chat?.messages || [];
  $('thread').hidden = !messages.length;
  $('thread').replaceChildren(...messages.map((message, i) =>
    makeMessage(message, { canRetry: i === messages.length - 1 }).article));
  renderStats();
  renderHistory();
  renderControls();
  scrollDown();
}

function renderAttachments() {
  $('attachments').hidden = !state.attachments.length;
  $('attachments').replaceChildren(...state.attachments.map((attachment, index) => {
    const tile = element('div', 'attachment');
    if (attachment.url) {
      const img = element('img');
      img.src = attachment.url;
      img.alt = attachment.name;
      tile.append(img);
    } else tile.append(element('span', 'file-name', attachment.name));
    const remove = iconButton('close', 'Remove ' + attachment.name);
    remove.disabled = state.busy;
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    tile.append(remove);
    return tile;
  }));
  renderControls();
}

let navigation = 0;
function resetDraft() {
  state.attachments = [];
  state.draftTools = null;
  setToolsOpen(false);
  syncTools();
  $('prompt').value = '';
  renderAttachments();
  status();
  hideMobileSidebar();
}

async function openChat(id) {
  if (chatLocked()) return;
  const request = ++navigation;
  try {
    const chat = await api('chats/' + encodeURIComponent(id));
    if (request !== navigation || chatLocked()) return;
    state.chat = chat;
    history.replaceState(null, '', '#' + chat.id);
    resetDraft();
    renderModels(chat.model);
    renderThread();
  } catch (error) {
    if (request === navigation) status(error.message);
  }
}

function newChat() {
  if (chatLocked()) return;
  navigation++;
  state.chat = null;
  history.replaceState(null, '', location.pathname);
  resetDraft();
  renderThread();
  $('prompt').focus();
}

async function submit(retry = false) {
  const model = $('models').value;
  const content = $('prompt').value.trim();
  const images = state.attachments.filter(item => item.url);
  const files = state.attachments.filter(item => !item.url);
  if (chatLocked() || state.modelState !== 'online' || !model || (!retry && !content && !state.attachments.length)) return;
  const id = state.chat?.id;
  const reply = { role: 'assistant', model, content: '', reasoning: '' };
  const assistant = makeMessage(reply, { streaming: true, canRetry: true });
  let started = false;
  let finished = false;
  let updateFrame = 0;
  let activity = '';
  function scheduleUpdate(nextActivity = '') {
    activity = nextActivity;
    if (updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      const stick = nearBottom();
      assistant.update(true, activity);
      if (stick) scrollDown();
    });
  }
  const notices = new Set();
  state.busy = true;
  state.stopping = false;
  state.streamId = null;
  navigation++;
  setToolsOpen(false);
  status();
  renderHistory();
  renderAttachments();
  try {
    const now = new Date();
    const localDateTime = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-') +
      ' ' + [now.getHours(), now.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
    const response = await request('chat', 'POST', {
      id, model, content: retry ? '' : content, images: retry ? [] : images, files: retry ? [] : files, retry,
      localDateTime, ...(state.settings?.shareTimezone && { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      ...(!id && state.draftTools && { tools: state.draftTools })
    });
    for await (const frame of sse(response.body)) {
      const event = JSON.parse(frame);
      if (event.type === 'start') {
        started = true;
        state.streamId = event.chat.id;
        const messages = state.chat?.messages || [];
        if (retry) messages.pop();
        else messages.push({ role: 'user', content, images, files });
        messages.push(reply);
        state.chat = { ...event.chat, messages, tools: event.tools };
        syncTools();
        state.list = [event.chat, ...state.list.filter(chat => chat.id !== event.chat.id)];
        history.replaceState(null, '', '#' + state.chat.id);
        if (!retry) {
          $('prompt').value = '';
          state.attachments = [];
        }
        renderAttachments();
        $('thread').hidden = false;
        if (retry) $('thread').lastElementChild?.remove();
        else $('thread').append(makeMessage(messages.at(-2)).article);
        $('thread').append(assistant.article);
        renderStats();
        renderHistory();
        scrollDown();
      } else if (event.type === 'content' || event.type === 'reasoning') {
        reply[event.type] += event.text;
        scheduleUpdate();
      } else if (event.type === 'tool') {
        scheduleUpdate('Using ' + event.text);
      } else if (event.type === 'notice') {
        notices.add(event.text);
        status([...notices].join(' '));
      } else if (event.type === 'done') {
        finished = true;
        reply.issue = event.issue;
        reply.stats = event.stats;
        renderStats();
      }
    }
    if (!finished) throw new Error('The connection closed before the reply finished.');
  } catch (error) {
    if (started) reply.issue = error.message;
    else status(error.message);
  } finally {
    if (updateFrame) cancelAnimationFrame(updateFrame);
    const stick = nearBottom();
    if (started) assistant.update(false);
    if (stick) scrollDown();
    state.busy = false;
    state.streamId = null;
    state.stopping = false;
    renderHistory();
    renderAttachments();
  }
}

async function stopReply() {
  if (!state.streamId || state.stopping) return;
  state.stopping = true;
  renderControls();
  try { await api('chats/' + state.streamId + '/stop', 'POST'); }
  catch (error) {
    status(error.message);
    state.stopping = false;
    renderControls();
  }
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, url: reader.result });
    reader.onerror = () => reject(new Error('Could not read ' + file.name + '.'));
    reader.readAsDataURL(file);
  });
}

async function attach(files) {
  if (state.busy) return;
  const candidates = [...files];
  const slots = 4 - state.attachments.length;
  const request = navigation;
  try {
    const selected = candidates.slice(0, slots);
    const attachments = await Promise.all(selected.map(async file => {
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type) && file.size <= 5 * 1024 * 1024) return readImage(file);
      if (file.size > 128 * 1024 ||
          (file.type && !/^(text\/|application\/(json|javascript|xml|x-yaml|toml)(?:$|;))/.test(file.type)) ||
          /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(file.name)) return null;
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        return content.includes('\0') || content.length > 100000 ? null : { name: file.name, content };
      } catch { return null; }
    }));
    if (request !== navigation || state.busy) return;
    state.attachments.push(...attachments.filter(Boolean).slice(0, 4 - state.attachments.length));
    status(attachments.some(item => !item) || candidates.length > slots ?
      'Attach up to four images (5 MB each) or UTF-8 text files (128 KB each).' : '');
    renderAttachments();
    $('prompt').focus();
  } catch (error) { status(error.message); }
}

const settingsDialog = $('settings');
const connectionFields = new Map();
let mcpCheck = 0;

function settingError(message = '') {
  $('settings-error').hidden = !message;
  $('settings-error').textContent = message;
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

async function openSettings() {
  try {
    const config = await api('settings');
    if (settingsDialog.open) return;
    state.settings = config;
    renderTools();
    renderControls();
    renderStats();
    $('endpoint').value = config.endpoint;
    $('api-key').value = '';
    $('api-key').placeholder = config.hasToken ? 'Saved' : 'Optional';
    $('system-prompt').value = config.systemPrompt;
    $('show-inference-stats').checked = config.showInferenceStats;
    $('share-timezone').checked = config.shareTimezone;
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
    settingsDialog.showModal();
    checkMcp();
  } catch (error) { status(error.message); }
}

$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const save = $('save-settings');
  if (save.disabled) return;
  save.disabled = true;
  settingError();
  const token = $('api-key').value;
  try {
    state.settings = await api('settings', 'PUT', {
      endpoint: $('endpoint').value.trim(),
      ...(token && { token }),
      systemPrompt: $('system-prompt').value,
      showInferenceStats: $('show-inference-stats').checked,
      shareTimezone: $('share-timezone').checked,
      toolDefaults: Array.from($('tool-defaults').querySelectorAll('input:checked'), input => input.value),
      mcp: [...connectionFields.values()].map(({ id, name, url, key, defaultToggle }) => ({
        id, name: name.value, url: url.value.trim(), enabledByDefault: defaultToggle.checked,
        ...(key.value && { token: key.value })
      }))
    });
    renderTools();
    renderStats();
    settingsDialog.close();
    status();
    state.modelState = 'loading';
    renderControls();
    await refreshModels();
  } catch (error) { settingError(error.message); }
  finally { save.disabled = false; }
});

document.querySelectorAll('[data-open-settings]').forEach(button => button.addEventListener('click', openSettings));
document.querySelectorAll('[data-close-settings]').forEach(button => button.addEventListener('click', () => settingsDialog.close()));
$('add-mcp').addEventListener('click', () => {
  if (connectionFields.size < 12) addConnection().focus();
  else settingError('You can add up to 12 connections.');
});
$('check-mcp').addEventListener('click', checkMcp);
$('tools-button').addEventListener('click', () => setToolsOpen($('tools-panel').hidden));
document.addEventListener('click', event => {
  if (!$('chat-tools').contains(event.target)) setToolsOpen(false);
});

const mobile = matchMedia('(max-width: 690px)');
function hideMobileSidebar() {
  document.body.classList.remove('sidebar-open');
  $('scrim').hidden = true;
}
$('close-sidebar').addEventListener('click', () => {
  if (mobile.matches) hideMobileSidebar();
  else document.body.classList.add('sidebar-collapsed');
  $('open-sidebar').focus();
});
$('open-sidebar').addEventListener('click', () => {
  document.body.classList.remove('sidebar-collapsed');
  if (mobile.matches) {
    document.body.classList.add('sidebar-open');
    $('scrim').hidden = false;
  }
  $('close-sidebar').focus();
});
$('scrim').addEventListener('click', hideMobileSidebar);
mobile.addEventListener('change', hideMobileSidebar);
function closeHistoryMenu() {
  $('history').querySelector('.history-menu:popover-open')?.hidePopover();
}
$('history').addEventListener('scroll', closeHistoryMenu, { passive: true });
window.addEventListener('resize', closeHistoryMenu);
const deleteSelected = $('delete-selected');
function selectedConversations() {
  return state.list.filter(chat => selectedChats.has(chat.id));
}

deleteSelected.addEventListener('click', () => askToDelete(selectedConversations()));
function focusHistoryRow(index) {
  const rows = $('history').querySelectorAll('.history-row');
  (rows[Math.min(Math.max(index, 0), rows.length - 1)] || $('new-chat')).focus();
}

$('sidebar').addEventListener('keydown', event => {
  const row = event.target.closest('.history-row');
  if ((!row && event.target !== deleteSelected) || event.isComposing || chatLocked()) return;
  if (event.key === 'Escape' && selectedChats.size) {
    if (!row) focusHistoryRow(state.list.findIndex(chat => chat.id === selectionAnchor));
    selectedChats.clear();
    selectionAnchor = null;
    renderHistorySelection();
  } else if (selectionModifier(event) && event.key.toLowerCase() === 'a' && !event.shiftKey && !event.altKey) {
    clickedChat = null;
    for (const chat of state.list) selectedChats.add(chat.id);
    renderHistorySelection();
  } else if (row && event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    const index = state.list.findIndex(chat => chat.id === row.dataset.id);
    const next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (state.list[next]) {
      selectRange(state.list[next].id, row.dataset.id, selectionModifier(event));
      focusHistoryRow(next);
    }
  } else if (!event.altKey && !event.shiftKey &&
    ((!selectionModifier(event) && event.key === 'Delete') ||
      (event.metaKey && !event.ctrlKey && event.key === 'Backspace'))) {
    askToDelete(selectedChats.size ? selectedConversations() : state.list.filter(chat => chat.id === clickedChat));
  } else return;
  event.preventDefault();
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || confirmDelete.open || $('history').querySelector('.history-menu:popover-open')) return;
  if (!$('tools-panel').hidden) {
    setToolsOpen(false);
    $('tools-button').focus();
    return;
  }
  if (document.body.classList.contains('sidebar-open')) {
    hideMobileSidebar();
    $('open-sidebar').focus();
  }
});

const confirmDelete = $('confirm-delete');
let chatsToDelete = [];
function askToDelete(chats) {
  if (chatLocked() || !chats.length || confirmDelete.open) return;
  chatsToDelete = chats;
  $('delete-title').textContent = chats.length === 1 ? 'Delete conversation?' : 'Delete ' + chats.length + ' conversations?';
  $('delete-description').textContent = chats.length === 1 ?
    '“' + chats[0].title + '” will be permanently deleted.' :
    'The selected conversations will be permanently deleted.';
  confirmDelete.returnValue = '';
  confirmDelete.showModal();
}
confirmDelete.addEventListener('close', async () => {
  const chats = chatsToDelete;
  chatsToDelete = [];
  if (confirmDelete.returnValue !== 'delete' || !chats.length || chatLocked()) return;
  const index = state.list.findIndex(chat => chat.id === chats[0].id);
  state.deleting = true;
  navigation++;
  renderControls();
  const results = await Promise.allSettled(chats.map(chat => request('chats/' + chat.id, 'DELETE')));
  const removed = new Set();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') removed.add(chats[i].id);
  });
  for (const id of removed) selectedChats.delete(id);
  if (removed.has(selectionAnchor)) selectionAnchor = null;
  if (removed.has(clickedChat)) clickedChat = null;
  state.list = state.list.filter(chat => !removed.has(chat.id));
  state.deleting = false;
  if (removed.has(state.chat?.id)) {
    newChat();
  } else {
    renderHistory();
    renderControls();
    if (document.activeElement === document.body) focusHistoryRow(index);
  }
  const failure = results.find(result => result.status === 'rejected');
  if (failure) status(chats.length === 1 ? failure.reason.message :
    'Could not delete ' + (chats.length - removed.size) + ' of ' + chats.length + ' conversations. ' + failure.reason.message);
});

$('new-chat').addEventListener('click', () => {
  selectedChats.clear();
  selectionAnchor = clickedChat = null;
  newChat();
});
$('retry-models').addEventListener('click', refreshModels);
document.addEventListener('visibilitychange', refreshModelsOnReturn);
window.addEventListener('focus', refreshModelsOnReturn);
$('models').addEventListener('change', renderControls);
$('attach').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', event => {
  attach(event.target.files);
  event.target.value = '';
});
$('prompt').addEventListener('input', renderControls);
$('prompt').addEventListener('paste', event => {
  const images = [...event.clipboardData?.files || []].filter(file => file.type.startsWith('image/'));
  if (images.length) {
    event.preventDefault();
    attach(images);
  }
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !mobile.matches) {
    event.preventDefault();
    if (!state.busy) submit();
  }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  if (state.busy) stopReply();
  else submit();
});

let dragDepth = 0;
document.addEventListener('dragenter', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  if (!state.busy && !settingsDialog.open && !confirmDelete.open) $('drop-layer').hidden = false;
});
document.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-layer').hidden = true;
});
document.addEventListener('drop', event => {
  dragDepth = 0;
  $('drop-layer').hidden = true;
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  if (!settingsDialog.open && !confirmDelete.open) attach(event.dataTransfer.files);
});

renderControls();
refreshModels();
api('settings').then(config => { state.settings = config; renderTools(); renderControls(); renderStats(); }).catch(error => status(error.message));
api('chats').then(list => {
  state.list = list;
  renderHistory();
  const id = location.hash.slice(1);
  if (list.some(chat => chat.id === id) && !state.chat && !state.busy && navigation === 0) openChat(id);
}).catch(error => status(error.message));

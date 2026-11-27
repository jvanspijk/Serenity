import { initializeChat } from './chat.js';
import { initializeSettings } from './settings.js';

const $ = id => document.getElementById(id);

const ns = 'http://www.w3.org/2000/svg';

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
  const multipart = data instanceof FormData;
  const response = await fetch('/api/' + path, {
    method,
    ...(multipart ? { body: data } : data !== undefined && {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    })
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not reach Serenity.');
  return response;
}

const api = async (...args) => (await request(...args)).json();

function toggleRow(label, checked) {
  const row = element('label', 'toggle-row', label);
  const input = element('input', 'toggle');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = checked;
  row.append(input);
  return { row, input };
}

function workspaceAccess(permissions) {
  if (permissions?.workspaceWrite) return 'Workspace read and write';
  if (permissions?.workspaceRead) return 'Workspace read';
  return '';
}

const settingsDialog = $('settings');
const chatSettings = initializeChat({
  settingsDialog, $, api, request, element, icon, iconButton, toggleRow, workspaceAccess
});
initializeSettings({
  dialog: settingsDialog, api, element, iconButton, toggleRow, workspaceAccess, ...chatSettings
});

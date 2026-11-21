# Build a Serenity plugin

Plugins add agent tools, skill instructions, or both. They do not add routes, UI, settings pages, or arbitrary server hooks. Install a plugin by placing its folder in `plugins/` and restarting Serenity. Plugins are disabled in chats by default; enable one under **Tools** or make it a default in **Settings**.

## Package format

Create `plugins/my-plugin/plugin.json`. The folder name and `id` must match. An ID starts with a lowercase letter and contains only lowercase letters, digits, `_`, or `-` (up to 40 characters).

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "My plugin",
  "description": "What its tools or skill do.",
  "main": "index.mjs",
  "tools": [
    {
      "name": "example",
      "description": "What the agent can accomplish with this tool.",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false
      }
    }
  ]
}
```

For a **skill-only** plugin, omit `main`, set `tools` to `[]`, and add `SKILL.md`. For a **tool-only** plugin, omit `SKILL.md`. A plugin may contain both. `SKILL.md` is plain Markdown (32 KiB maximum) and is added to the system prompt only when the plugin is enabled for that chat. Keep instructions specific to the plugin's tools or domain. They are not a way to change Serenity's global behavior.

Tool plugins export `run(toolName, args)` from `index.mjs`:

```js
export async function run(toolName, args) {
  if (toolName !== 'example' || typeof args.text !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'Invalid input.' }] };
  }
  return { content: [{ type: 'text', text: args.text.toUpperCase() }] };
}
```

Validate arguments in the plugin because the model can produce values outside the advertised schema. Return a JSON-serializable object. `content` with text entries is the recommended result shape. Keep output concise and never put secrets in tool results. Serenity prefixes tool names with `plugin_`, the plugin ID length, and the plugin ID. The full registered name must be at most 64 characters. A plugin can declare up to 12 tools. See [the complete example](../examples/word-count/).

## File access and permissions

Tool code runs in a separate Node process with the Node permission system enabled. It receives only the tool name and JSON arguments. Network access, child processes, native addons, and filesystem writes are denied by default. The process has a 10-second limit, a 64 MiB JavaScript heap limit, and 64 KiB input and output limits. It can read its own plugin folder. Dependencies must live in that folder and be importable as ES modules; Serenity does not run package install scripts.

If a tool needs file access, the operator first sets `PLUGIN_WORKSPACE` to an explicitly chosen directory. The plugin then declares one or both permissions:

```json
"permissions": { "workspaceRead": true, "workspaceWrite": true }
```

`workspaceWrite` requires `workspaceRead`. Without `PLUGIN_WORKSPACE`, a plugin requesting either permission is skipped. In Docker, mount only the intended directory into the container and set `PLUGIN_WORKSPACE` to that mount path. Do not mount `/data`, the home directory, or the Docker socket as the workspace. The plugin's permissions appear in Settings. A file-editing plugin should validate paths and content, avoid symlink traversal, and return a summary of changes. The SDK does not provide a per-edit approval dialog.

Tool code with a workspace grant can read the configured path from `process.env.PLUGIN_WORKSPACE`. For Compose, use a `compose.override.yaml` next to `compose.yaml`. Create `plugin-workspace/` first and give the container's user access.

```yaml
services:
  sage-chat:
    environment:
      PLUGIN_WORKSPACE: /workspace
    volumes:
      - ./plugin-workspace:/workspace
```

Use the Node permission system as an extra safeguard for reviewed code. Node follows filesystem symlinks, so keep plugin folders and any workspace free of links to private files. Only install plugins whose code and dependencies you trust. Review `SKILL.md` too, since it can influence what the agent does with other enabled tools. Keep user uploads out of the plugin directory. Ask contributors for the source, test inputs, and a description of any files the tool can change. Distribute reviewed versions. Serenity uses a single shared configuration.

## Try the example

Copy `examples/word-count` to `plugins/word-count`. Restart Serenity (`docker compose up --build -d sage-chat` for Compose, or restart `npm start` for source). Open Settings to see **Word count**, enable it in a chat, and ask for a precise count. New plugin folders are discovered at startup.

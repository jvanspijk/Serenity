# Project instructions

Limit edits to Serenity’s system prompt to typo and grammar fixes.

## Serenity’s core tenets

- Only what’s necessary, zero fluff
- Fewer, better features
- Narrowly scoped features that solve specific problems well
- Small disk footprint and low runtime resource use
- Minimizing mental effort

## Implementation guidelines

After changing application code, ensure the running app serves the updated code before reporting completion. If the app is running in Docker Compose, rebuild and restart it with `docker compose up --build -d serenity`. If it is running directly with Node.js, restart that server. Verify the change against the running app on its configured port.

When adding or changing UI elements, always use professional guidelines for spacing and layout.

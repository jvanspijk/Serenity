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

- Avoid overly specific code that makes it hard to compose or reuse when building new functionality.
- Prefer elegant solutions that handle special cases inherently; avoid methods that need lots of special case handling when a simpler solution can account for them.

## Compatibility and regression tests

- Do not keep compatibility in code paths or take the old situation into account. Clear conversation data so the new situation is used and the old one no longer needs to be considered.
- Remove all regression tests before committing.

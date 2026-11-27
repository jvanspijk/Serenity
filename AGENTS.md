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
- Keep one source of truth. Derive related state from it where practical.
- Save authoritative state before updating derived state. Make the update safe to repeat.
- Use one rule for normal operations, retries, and recovery when possible. Add a special case only when a concrete requirement needs it.
- When several edge cases need separate checks, look for a simpler design that handles them by default. Use native platform behavior or a shared rule where it fits.
- If a refactor would remove checks, state, or code paths while preserving intended behavior, consider it. Verify the affected flows if you make the change.

## Compatibility and regression tests

- Do not keep compatibility in code paths or take the old situation into account. Clear conversation data so the new situation is used and the old one no longer needs to be considered.
- Remove all regression tests before committing.

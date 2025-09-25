# Repository Guidelines

## Project Structure & Module Organization
The runtime code lives under `src/server`, with `index.ts` bootstrapping the Express + Socket.IO service and `resilience/` holding the browser session managers (`BrowserManager.ts`, `MemoryManager.ts`, etc.). Build artifacts emit into `dist/` after compilation. Deployment helpers sit at the root (`Dockerfile`, `fly.toml`, `FLY_SECRETS_GUIDE.md`), and environment variables are consumed via `.env` using `dotenv`.

## Build, Test, and Development Commands
Run `pnpm install` once to sync dependencies. Use `pnpm dev` for iterative development; it watches `src/server` with `tsx` and restarts on changes. Build production assets with `pnpm build` (TypeScript compile using `tsconfig.server.json`). Launch the compiled server locally via `pnpm start`, which runs `node dist/index.js` with the memory flags we rely on in production.

## Coding Style & Naming Conventions
Write TypeScript using ES module imports. Follow the existing two-space indentation and trailing comma style. Name classes with PascalCase (`ResilientBrowserManager`), functions and variables with camelCase, and Socket.IO events with snake_case payload fields. Keep modules narrowly scoped (e.g., session logic under `resilience/`) and colocate helpers near their consumers. When introducing linting or formatting tools, document the command in this guide.

## Testing Guidelines
There is no automated test runner yet; please add one alongside new test suites. Prefer integration-style tests under `src/server/__tests__` (e.g., using `vitest` or `jest`) that exercise critical flows like session creation and screencast handling. Until we formalize the test script, provide manual verification notes in your PR (for example, steps performed while running `pnpm dev`).

## Commit & Pull Request Guidelines
Commits should be concise, present-tense summaries of the change (`memory management`, `reconnect for the lulz`). Group related edits and avoid mixing refactors with feature work. For pull requests, include: 1) a one-paragraph summary of behaviour change, 2) links to any tracking issues, 3) screenshots or logs for UI/socket changes, and 4) deployment or rollback considerations (ports, Fly secrets). Mention reviewers when the change impacts shared infrastructure.

## Security & Configuration Tips
Keep `.env` files out of version control and document new keys in `FLY_SECRETS_GUIDE.md`. When altering browser streaming settings, audit memory usage thresholds in `MemoryManager` to prevent regressions. Verify CORS or auth tweaks against the production configuration defined in `fly.toml` before rollout.

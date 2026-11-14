set shell := ["bash", "-euo", "pipefail", "-c"]

check:
  node scripts/check-boundaries.mjs
  pnpm -r --if-present typecheck

test:
  node scripts/check-boundaries.mjs
  pnpm -r --if-present test

e2e:
  node scripts/verify-e2e.mjs

start:
  pnpm --filter @live-for-llm/desktop start

daemon:
  pnpm --filter @live-for-llm/daemon start

desktop:
  pnpm --filter @live-for-llm/desktop start

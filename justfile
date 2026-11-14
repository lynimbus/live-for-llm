set shell := ["bash", "-euo", "pipefail", "-c"]

check:
  node scripts/check-boundaries.mjs
  pnpm -r --if-present typecheck

test:
  node scripts/check-boundaries.mjs
  pnpm -r --if-present test

e2e:
  node scripts/verify-e2e.mjs

#!/usr/bin/env bash
# Run the shatool test suite. Thin wrapper over tests/run.js so that the
# entry point is the same shape as the sibling 256-shavar repo's.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tests/run.js "$@"

#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Starting Darkroom's local FUT.GG bridge…"
open "https://www.fut.gg/tactics/"
node server/futgg-bridge.js

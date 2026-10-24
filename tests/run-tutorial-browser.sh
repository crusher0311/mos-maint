#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The bundled headless browser uses host NSS/NSPR. Standard Linux installs
# already provide them; Replit's Nix environment keeps them outside ldconfig.
if [[ -d /nix/store ]]; then
  for directory in /nix/store/*-nspr-*/lib /nix/store/*-nss-*/lib; do
    [[ -d "$directory" ]] && export LD_LIBRARY_PATH="$directory:${LD_LIBRARY_PATH:-}"
  done
fi
node --import tsx --test tests/tutorial-browser.test.ts

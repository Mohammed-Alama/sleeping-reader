#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org and try again."
  read -r "?Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install
fi

npm run dev -- --open

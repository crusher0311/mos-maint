#!/bin/bash
set -o errexit

echo "Installing dependencies..."
npm install --legacy-peer-deps

echo "Building application..."
echo "Note: @sparticuz/chromium provides its own bundled Chrome for sticker generation"
npm run build

echo "Build complete!"

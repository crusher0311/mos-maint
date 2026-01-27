#!/bin/bash
set -o errexit

echo "Installing dependencies..."
npm install

echo "Setting up Puppeteer cache directory..."
export PUPPETEER_CACHE_DIR=/opt/render/project/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

echo "Installing Puppeteer Chrome browser to $PUPPETEER_CACHE_DIR..."
npx puppeteer browsers install chrome

echo "Verifying Chrome installation..."
ls -la $PUPPETEER_CACHE_DIR || echo "Cache directory listing failed"
find $PUPPETEER_CACHE_DIR -name "chrome" -type f 2>/dev/null | head -5 || echo "Chrome binary not found in search"

echo "Building application..."
npm run build

echo "Build complete!"

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

# Find and display the Chrome executable path
CHROME_PATH=$(find $PUPPETEER_CACHE_DIR -name "chrome" -type f 2>/dev/null | head -1)
if [ -n "$CHROME_PATH" ]; then
    echo "Chrome found at: $CHROME_PATH"
    echo "PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH" >> .env.production
else
    echo "WARNING: Chrome binary not found after installation"
    find $PUPPETEER_CACHE_DIR -type f -name "*chrome*" 2>/dev/null | head -10
fi

echo "Building application..."
npm run build

echo "Build complete!"

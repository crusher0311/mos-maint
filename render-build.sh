#!/bin/bash
set -o errexit

echo "Installing dependencies..."
npm install

echo "Installing Puppeteer Chrome browser..."
npx puppeteer browsers install chrome

echo "Building application..."
npm run build

echo "Build complete!"

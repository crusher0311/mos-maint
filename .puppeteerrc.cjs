const { join } = require('path');

/**
 * Puppeteer Configuration for Render.com hosting
 * 
 * Render doesn't persist the default cache directory (/opt/render/.cache),
 * so we need to store Chrome in the project directory.
 * 
 * Set PUPPETEER_CACHE_DIR=/opt/render/project/puppeteer in Render environment
 */
module.exports = {
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || '/opt/render/project/puppeteer',
};

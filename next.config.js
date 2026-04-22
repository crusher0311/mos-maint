/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    serverActions: {
      allowedOrigins: ['*'],
    },
    instrumentationHook: true,
    serverComponentsExternalPackages: ['mongodb', 'node-cron'],
  },
  webpack: (config, { isServer }) => {
    // The instrumentation hook intentionally uses dynamic require() to load
    // the cron scheduler at runtime (so the scheduler stays out of the
    // bundle when ENABLE_INPROCESS_CRON is unset). Webpack can't statically
    // analyze those requires and emits noisy warnings on every Fast Refresh
    // ("Critical dependency: the request of a dependency is an expression"
    // and "Module not found: Can't resolve 'path'"). Silence them — they're
    // expected and intentional in this file.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /src\/instrumentation\.ts$/ },
      {
        message:
          /Critical dependency: the request of a dependency is an expression/,
      },
      { message: /Can't resolve 'path' in .*\/src/ },
    ];
    return config;
  },
};
module.exports = nextConfig;

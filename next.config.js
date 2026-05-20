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
    // The cron scheduler is loaded at runtime via eval("require") from
    // src/instrumentation.ts so that webpack doesn't statically analyze it
    // (which would emit noisy "Critical dependency" warnings on every Fast
    // Refresh). The side effect is that Next's file tracer also can't see
    // these files and would otherwise prune them from the deployed build,
    // causing prod to log "Cannot find module '.../lib/cron/scheduler.cjs'"
    // and the in-process scheduler never starts. Force-include them here.
    outputFileTracingIncludes: {
      '/': ['./lib/cron/*.cjs'],
    },
  },
  webpack: (config, { isServer, dev }) => {
    // Next 14's instrumentation hook is bundled separately and does NOT
    // honor `experimental.serverComponentsExternalPackages`. The host-load
    // sampler (task #460) imports `mongodb` transitively via `lib/mongo.ts`,
    // and without an explicit external here webpack tries to resolve
    // mongodb's Node-only deps (`net`, `crypto`, `tls`) at build time and
    // fails the build. Marking these as commonjs externals on the server
    // bundle leaves them to Node's runtime resolver, which is what we want.
    if (isServer) {
      const serverExternals = [
        'mongodb',
        'mongodb-client-encryption',
        'kerberos',
        'aws4',
        'snappy',
        '@mongodb-js/zstd',
        'gcp-metadata',
        'socks',
      ];
      const externalize = ({ request }, callback) => {
        if (request && serverExternals.includes(request)) {
          return callback(null, 'commonjs ' + request);
        }
        callback();
      };
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, externalize]
        : [config.externals, externalize].filter(Boolean);
    }

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

    // Stop the dev server from rebuilding non-stop while idle. Next's
    // default watcher walks the entire project root, which on Replit
    // includes platform-managed directories that get written to constantly
    // — most importantly `.local/state/workflow-logs/<id>/...exec.0`,
    // which is this very dev server's own stdout. Each compile log line
    // touches that file, the watcher fires, webpack schedules another
    // rebuild, and the loop never settles. Ignoring these paths breaks
    // the cycle. `_archive` and `attached_assets` are excluded too — they
    // hold stale/unused content and only add watch overhead.
    if (dev) {
      // Replace (don't merge) Next's default `ignored`. Webpack 5 rejects
      // arrays that mix RegExp + string entries, and Next's default is a
      // regex covering node_modules — already included in our globs below.
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/.git/**',
          '**/node_modules/**',
          '**/.next/**',
          '**/.local/**',
          '**/.cache/**',
          '**/.upm/**',
          '**/.config/**',
          '**/.dataone/**',
          '**/_archive/**',
          '**/attached_assets/**',
          '**/.replit_integration_files/**',
          '**/tsconfig.tsbuildinfo',
        ],
      };
    }

    return config;
  },
};
module.exports = nextConfig;

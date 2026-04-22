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
};
module.exports = nextConfig;

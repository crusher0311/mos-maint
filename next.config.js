/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  compress: true,
  experimental: {
    serverActions: {
      allowedOrigins: ['*'],
    },
  },
};
module.exports = nextConfig;

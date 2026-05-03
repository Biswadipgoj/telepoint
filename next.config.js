/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: '*.ibb.co' },
      { protocol: 'https', hostname: 'i.ibb.co' },
    ],
  },
};
module.exports = nextConfig;

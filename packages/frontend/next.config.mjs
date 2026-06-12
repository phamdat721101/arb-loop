/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  experimental: {
    // @cofhe/sdk WASM resolves natively from node_modules — keep it server-external.
    serverComponentsExternalPackages: ['@cofhe/sdk'],
  },
  webpack: (config, { isServer }) => {
    // Stub the React Native storage module pulled in by @metamask/sdk → @wagmi/connectors.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };
    config.resolve.fallback = { fs: false, net: false, tls: false };
    // Enable async WebAssembly for the client bundle (TFHE used by CoFHE SDK).
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };
    return config;
  },
  // Legacy → openx URL map. All temporary (308) so search engines don't
  // freeze a stale redirect once the rewrite settles.
  async redirects() {
    return [
      { source: '/onboard', destination: '/docs', permanent: false },
      { source: '/payments', destination: '/settings', permanent: false },
      { source: '/v2', destination: '/', permanent: false },
      { source: '/zama-demo', destination: '/', permanent: false },
      { source: '/catalog', destination: '/marketplace', permanent: false },
      { source: '/settings-v2', destination: '/settings', permanent: false },
      { source: '/memory', destination: '/brain', permanent: false },
      { source: '/chat', destination: '/marketplace', permanent: false },
    ];
  },
};

export default config;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@deepgram/sdk", "epub-gen-memory", "pdfkit", "@sparticuz/chromium", "playwright-core"],
  experimental: {
    serverActions: { bodySizeLimit: "30mb" },
  },
  allowedDevOrigins: ["*.replit.dev", "*.replit.app", "*.riker.replit.dev"],
  outputFileTracingIncludes: {
    "/api/ebook/export": ["./node_modules/pdfkit/js/data/**/*"],
    "/api/nexuslm/export": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      "./node_modules/@sparticuz/chromium/build/**/*",
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { isServer }) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "next/dist/next-devtools/userspace/app/segment-explorer-node.js": false,
    };

    if (isServer) {
      const existing = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
      config.externals = [
        ...existing,
        { "epub-gen-memory": "commonjs epub-gen-memory" },
      ];
    }
    return config;
  },
};

export default nextConfig;

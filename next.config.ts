import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Node-only libraries used by email ingestion; keep them out of the webpack bundles.
  serverExternalPackages: ["imapflow", "mailparser", "nodemailer"],
};

export default nextConfig;

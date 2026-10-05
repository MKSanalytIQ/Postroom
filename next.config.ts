import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * CSP notes:
 * - script-src 'unsafe-inline' is required for Next.js App Router inline bootstrapping.
 * - frame-src 'none' blocks embedding our pages in frames; template previews use sandboxed
 *   iframes with srcDoc (same-origin child) and do not need frame-src to third parties.
 * - connect-src includes https: for optional Sentry and same-origin APIs.
 * - Tracking pixel, click redirects, and unsubscribe are same-origin navigations/images — allowed.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' https:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["bcryptjs", "nodemailer"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

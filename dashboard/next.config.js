/** @type {import('next').NextConfig} */

// Upstream daemon HTTP API. The dashboard SERVER (running on the Mini) proxies
// every `/api/*` request to this address from loopback — so a remote browser on
// the tailnet only ever talks to the dashboard's own origin and never needs to
// reach the API directly. Keep this pointed at loopback; the API stays bound to
// 127.0.0.1 and is never exposed. Override only if the API moves host/port.
const API_UPSTREAM = process.env.LOCALJOBS_API_UPSTREAM ?? 'http://127.0.0.1:4789';

const nextConfig = {
  async rewrites() {
    // `beforeFiles` so `/api/*` is ALWAYS proxied to the loopback API before
    // Next's own routing — never served by the app (which would 404 it).
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${API_UPSTREAM}/api/:path*`,
        },
      ],
    };
  },
};

module.exports = nextConfig;

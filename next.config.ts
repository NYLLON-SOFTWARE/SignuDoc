import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // Whether Vercel BotID is on, decided once at build time so the browser
    // code that adds its proof and the server code that checks it cannot
    // disagree. It only works on Vercel, and is opt-in with BOTID=1. See
    // src/lib/security/botid.ts.
    NEXT_PUBLIC_BOTID:
      process.env.VERCEL === "1" && process.env.BOTID === "1" ? "1" : "",
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

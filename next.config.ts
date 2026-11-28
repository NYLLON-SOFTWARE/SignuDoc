import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

import { MAX_REQUEST_BODY_BYTES } from "./src/lib/types/domain.ts";

// The version this deployment runs, compared with the latest release by
// "Check for updates" in Settings (src/lib/software-update.ts).
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

const nextConfig: NextConfig = {
  ...(process.env.NEXT_STANDALONE === "1" && {
    output: "standalone",
    // A 20 MiB PDF needs room for multipart overhead through Next's proxy.
    experimental: { proxyClientMaxBodySize: "25mb" },
  }),
  env: {
    NEXT_PUBLIC_SIGNUDOC_VERSION: version,
    // Whether Vercel BotID is on, decided once at build time so the browser
    // code that adds its proof and the server code that checks it cannot
    // disagree. It only works on Vercel, and is opt-in with BOTID=1. See
    // src/lib/security/botid.ts.
    NEXT_PUBLIC_BOTID:
      process.env.VERCEL === "1" && process.env.BOTID === "1" ? "1" : "",
  },
  experimental: {
    // Every request passes through the Proxy (src/proxy.ts), and Next.js
    // keeps only the first 10 MB of a body that does. With local disk
    // storage the PDF is sent in the request itself, so the limit has to
    // fit a PDF at the 20 MB upload limit and the rest of the form.
    // https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize
    proxyClientMaxBodySize: MAX_REQUEST_BODY_BYTES,
  },
  images: {
    unoptimized: true,
  },
  // Finished PDFs are drawn with fonts read from disk at runtime, cut down
  // by a WebAssembly subsetter (src/lib/services/pdf-fonts.ts). Listing the
  // files here makes sure they are copied into the deployed functions.
  outputFileTracingIncludes: {
    "/api/**": [
      "./src/assets/fonts/*.ttf",
      "./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm",
    ],
  },
};

export default nextConfig;

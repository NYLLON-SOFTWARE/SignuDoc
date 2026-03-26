import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "coverage/**",
    "next-env.d.ts",
    "out/**",
    "build/**",
    "public/pdfjs/**",
  ]),
]);

export default eslintConfig;

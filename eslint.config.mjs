import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks 7 added React Compiler rules. The field
    // editor predates them. They stay visible as warnings until the editor
    // is refactored, rather than being rewritten as part of an upgrade.
    files: ["src/components/envelopes/prepare-live-shell.tsx"],
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
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

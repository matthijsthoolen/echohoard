import js from "@eslint/js";

export default [
  { ignores: ["**/.next/**", "coverage/**", "**/dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
      },
    },
  },
  { rules: { "no-warning-comments": "error" } },
];

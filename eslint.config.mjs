import js from "@eslint/js";

export default [
  { ignores: [".next/**", "coverage/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  { rules: { "no-warning-comments": "error" } },
];

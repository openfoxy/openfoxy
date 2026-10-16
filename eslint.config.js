import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "chrome/", ".agent-logs/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    // Extension files are classic scripts loaded by the browser, not ES modules.
    files: ["extension/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ["extension/background.js"],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } },
  },
];

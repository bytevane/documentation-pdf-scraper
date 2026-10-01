import js from "@eslint/js";
import globals from "globals";
import json from "@eslint/json";
import { defineConfig, globalIgnores } from "eslint/config";

// Files that pass callbacks to page.evaluate(); those callbacks run in the browser.
const PAGE_CONTEXT_FILES = [
  "src/core/scraper.js",
  "src/core/urlCollector.js",
  "src/services/imageService.js",
  "src/services/markdownService.js",
  "src/services/pageManager.js",
  "src/services/pdfStyleService.js",
  "src/services/translationService.js",
  "scripts/inspect-*.js",
  "scripts/test-expand-collapsibles.js",
  "scripts/test-openai-access.js",
  "scripts/verify-expansion.js",
];

export default defineConfig([
  globalIgnores([
    "node_modules/",
    "coverage/",
    "pdfs/",
    "output/",
    "output2/",
    ".venv/",
    ".temp/",
    ".cache/",
    "package-lock.json",
  ]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: PAGE_CONTEXT_FILES,
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["tests/**/*.{js,mjs,cjs}"],
    rules: { "no-unused-vars": "off" },
  },
  { files: ["**/*.json"], plugins: { json }, language: "json/json", extends: ["json/recommended"] },
]);

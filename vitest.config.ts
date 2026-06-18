import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    // Keep vitest's defaults (node_modules, dist, …) and also skip agent worktree
    // copies under .claude/ and build output under out/ — without spreading the
    // defaults, setting `exclude` would override them and vitest would scan
    // node_modules.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/out/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

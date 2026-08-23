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
    coverage: {
      provider: "v8",
      // Application code only. scripts/ is 228 one-shot ops tools run by hand,
      // never imported by the app — including them would drown the signal.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/__tests__/**", "src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

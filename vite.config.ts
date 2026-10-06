import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { metaImagesPlugin } from "./vite-plugin-meta-images";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    tailwindcss(),
    metaImagesPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /*
         * Matched on resolved module path rather than by package name.
         *
         * The object form this replaces named only the bare entry modules, so
         * React's actual runtime (react/jsx-runtime, react-dom/client,
         * scheduler) went unclaimed and Rollup folded it into whichever vendor
         * chunk reached it first — which was vendor-recharts. That left
         * vendor-react a 1-byte empty file and made the entry chunk statically
         * import 109KB gzipped of charting library, downloaded by every
         * visitor to the landing page even though charts only ever render
         * inside the authenticated dashboard.
         *
         * Path matching claims every module in each package, so React lands in
         * exactly one chunk. That part matters beyond bundle size: two copies
         * of React on a page means two hook dispatchers, and every component
         * throws.
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (/[\\/]node_modules[\\/](react-dom|react|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          /*
           * clsx / tailwind-merge / cva are a few hundred bytes each and are
           * used by every UI component, but recharts imports them too. Left
           * unclaimed they fall under Vite's small-chunk merging and get
           * absorbed into vendor-recharts — which then drags the entire chart
           * library into the entry chunk over one 300-byte helper. Pin them to
           * the chunk that is loaded on every page anyway.
           */
          if (
            /[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/.test(id)
          ) {
            return "vendor-react";
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) {
            return "vendor-query";
          }
          // The optional analytics SDK must remain lazy, after consent only.
          if (/[\\/]node_modules[\\/](posthog-js|@posthog)[\\/]/.test(id)) {
            return "vendor-posthog";
          }
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) {
            return "vendor-recharts";
          }
          if (/[\\/]node_modules[\\/]framer-motion[\\/]/.test(id)) {
            return "vendor-motion";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});

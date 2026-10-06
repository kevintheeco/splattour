import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

const SCENES_DIR = path.resolve(import.meta.dirname, "../scenes");

const MIME = {
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ply": "application/octet-stream",
  ".spz": "application/octet-stream",
  ".splat": "application/octet-stream",
  ".ksplat": "application/octet-stream",
  ".sog": "application/octet-stream",
};

// Serves ../scenes at /scenes so processed scenes are viewable without copying.
function scenesMiddleware() {
  const handler = (req, res, next) => {
    const url = decodeURIComponent((req.url || "").split("?")[0]);
    if (!url.startsWith("/scenes/")) return next();
    const file = path.join(SCENES_DIR, url.slice("/scenes/".length));
    if (!file.startsWith(SCENES_DIR)) return next();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return next();
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Length", st.size);
      res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(file).pipe(res);
    });
  };
  return {
    name: "splattour-scenes",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [scenesMiddleware()],
  // /api goes to the studio server (edit mode saves tours through it)
  server: { port: 5190, host: true, proxy: { "/api": "http://localhost:5200" } },
  preview: { port: 5191, host: true },
  build: { target: "es2022", chunkSizeWarningLimit: 4000, rollupOptions: { input: { tour: "index.html", home: "home.html", manual: "manual.html", upload: "upload.html", listing: "listing.html", pano: "pano.html", mapEditor: "map-editor.html", panoAdditional: "pano-additional.html", study: "study.html" } } },
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
});

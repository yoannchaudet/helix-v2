/* Minimal static file server for the Playwright suite. Serves `src/` so the real
 * index.html + ES modules load over http (ES modules + the app's absolute paths like
 * `/main.js` don't work under file://). No dependencies — just Node's http + fs.
 *
 * Usage: node tests/e2e/serve.js [port]   (defaults to 5599) */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const port = Number(process.argv[2]) || 5599;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    // Strip the query string, default to index.html, and resolve within `root` only.
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, () => {
  console.log(`static server on http://localhost:${port} (root: ${root})`);
});

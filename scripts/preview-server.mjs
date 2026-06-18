// Tiny static server for the Demand Gen contact sheet. Root = the _previews dir,
// so "/" serves index.html and "/<asset>.png" serves the sibling frames.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("out/demand-gen/_previews");
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json", ".mp4": "video/mp4" };

http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
  // contain within ROOT
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end("not found: " + rel);
  }
}).listen(8080, () => console.log("Serving contact sheet at http://localhost:8080  (root: " + ROOT + ")"));

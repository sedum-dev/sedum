import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";

/**
 * Serve `/real/<site>/snapshot.html` from `<store>/<site>/snapshot.html.gz`.
 * Only that path shape is served; everything else is 404.
 */
export function serveStore(store) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    const match = /^\/real\/([a-z0-9-]+)\/snapshot\.html$/.exec(path);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(join(store, match[1], "snapshot.html.gz"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((ready) =>
    server.listen(0, "127.0.0.1", () =>
      ready({ server, base: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

import { createServer } from "node:http";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const port = Number(process.env.CACHE_FIXTURE_PORT ?? 23600);
const long = "Public descriptive context for this item. ".repeat(8);
const action = (id, label, result = id) =>
  `<button id="${id}" onclick="document.querySelector('#result').textContent='${result}'">${label}</button>`;
const catalog = ["Button Camera", "Camera", "Link Camera"]
  .map(
    (title, index) =>
      `<article><h2>${title}</h2><p>${long}</p>${action(`buy-${index}`, "Buy", `Purchase confirmation: Purchased ${title}`)}</article>`,
  )
  .join("");
const queue = ["Archived", "Pending"]
  .map(
    (section) =>
      `<section aria-label="${section}"><h2>${section}</h2><table><tr><td><p>Alice</p><p>${long}</p>${action(section.toLowerCase(), "Approve")}</td></tr></table></section>`,
  )
  .join("");
const settings = `<label>Display Name<input id="display"></label><label>Password<input id="password" type="password"></label>${action("save", "Save", "Confirmation: Saved settings")}${action("finish", "Finish", "Confirmation: Finished setup")}`;
const pages = { "/catalog": catalog, "/queue": queue, "/settings": settings };

createServer((request, response) => {
  const body = pages[new URL(request.url, `http://localhost:${port}`).pathname];
  if (!body) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html",
    "cache-control": "no-store",
  });
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sentence cache fixture</title><style>body{font:18px system-ui;max-width:960px;margin:32px auto;color:#172435}article,section{border:1px solid #b9c5d3;padding:18px;margin:14px 0}p{max-width:700px}button,input{font:inherit;padding:9px;margin:8px}label{display:block}#result{position:sticky;top:0;background:#e5f6ec;padding:16px}</style><h1>Sentence cache fixture</h1><p id="result" role="status">Ready</p><main>${body}</main></html>`,
  );
}).listen(port, "0.0.0.0", () =>
  console.log(`Sentence fixtures listening on ${port}`),
);

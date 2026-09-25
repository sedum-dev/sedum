import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { URL } from "node:url";
import process from "node:process";

const require = createRequire(
  new URL("../../../../packages/core/package.json", import.meta.url),
);
/** The same Playwright build the engine uses. */
export const { chromium } = require("playwright-core");

export const VIEWPORT = { width: 1280, height: 900 };
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/**
 * Chromium flags for a TLS-intercepting egress proxy. When
 * SEDUM_CAPTURE_CA names the proxy's CA certificate, Chromium trusts that one
 * key; verification stays on for everything else.
 */
function proxyOptions() {
  const server = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!server) return {};
  const ca = process.env.SEDUM_CAPTURE_CA;
  const args = [];
  if (ca && existsSync(ca)) {
    const spki = execFileSync(
      "sh",
      [
        "-c",
        'openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64',
        "sh",
        ca,
      ],
      { encoding: "utf8" },
    ).trim();
    args.push(`--ignore-certificate-errors-spki-list=${spki}`);
  }
  return { proxy: { server }, args };
}

/** A browser for live sites, through the environment's proxy when one is set. */
export function launchLive() {
  return chromium.launch(proxyOptions());
}

/** A browser for frozen snapshots: no proxy, so nothing reaches the network. */
export function launchOffline() {
  return chromium.launch({ args: ["--proxy-server=http://127.0.0.1:9"] });
}

/** Where snapshots and page-derived replies live. Never committed. */
export function storeDir(realRoot) {
  return process.env.SEDUM_EVAL_STORE ?? join(realRoot, "store");
}

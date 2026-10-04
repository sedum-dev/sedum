import { createPageBridge } from "./runtime.js";

if (!window.__sedum) {
  const bridge = createPageBridge();
  Object.freeze(bridge);
  Object.defineProperty(window, "__sedum", {
    value: bridge,
    configurable: false,
    writable: false,
  });
}

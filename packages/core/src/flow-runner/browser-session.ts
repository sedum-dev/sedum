import type {
  BrowserContextOptions,
  BrowserPage,
  BrowserSession,
} from "../browser-driver.js";
import type { AttemptDependencies } from "./contracts.js";
import type { PreparedFlow } from "./orchestration-context.js";
import { closeQuietly } from "./support.js";
import { RuntimeUrl, executeStep } from "../step-executor.js";

interface BrowserResources {
  session?: BrowserSession;
  context?: Awaited<ReturnType<BrowserSession["newContext"]>>;
  page?: BrowserPage;
}

function launchOptions(prepared: PreparedFlow) {
  const dependencies = prepared.dependencies;
  return {
    ...(dependencies.browserKind === undefined
      ? {}
      : { browser: dependencies.browserKind }),
    ...(dependencies.headless === undefined
      ? {}
      : { headless: dependencies.headless }),
    ...(dependencies.slowMoMs === undefined
      ? {}
      : { slowMoMs: dependencies.slowMoMs }),
    ...(dependencies.headedOverlay ? { overlay: true } : {}),
  };
}

/** Context options shared by flow and script tests. */
export function contextOptions(
  dependencies: Pick<AttemptDependencies, "viewport" | "detector">,
): BrowserContextOptions {
  return {
    ...(dependencies.viewport === undefined
      ? {}
      : { viewport: dependencies.viewport }),
    ...(dependencies.detector ? { collectSignals: true } : {}),
  };
}

async function openBrowser(
  prepared: PreparedFlow,
  resources: BrowserResources,
): Promise<BrowserPage> {
  const dependencies = prepared.dependencies;
  resources.session = await dependencies.browser.launch(
    launchOptions(prepared),
  );
  resources.context = await resources.session.newContext(
    contextOptions(dependencies),
  );
  const page = await resources.context.newPage();
  resources.page = page;
  await executeStep(
    page,
    { op: "goto", url: new RuntimeUrl([prepared.entryUrl]) },
    dependencies.signal ? { signal: dependencies.signal } : {},
  );
  return page;
}

async function closeBrowser(resources: BrowserResources): Promise<void> {
  await closeQuietly(resources.page);
  await closeQuietly(resources.context);
  await closeQuietly(resources.session);
}

/** Own browser resources and preserve page, context, session close order. */
export async function withFlowBrowser<T>(
  prepared: PreparedFlow,
  execute: (page: BrowserPage) => Promise<T>,
): Promise<T> {
  const resources: BrowserResources = {};
  try {
    return await execute(await openBrowser(prepared, resources));
  } finally {
    await closeBrowser(resources);
  }
}

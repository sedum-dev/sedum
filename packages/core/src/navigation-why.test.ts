import { describe, expect, it } from "vitest";
import { navigationWhy } from "./flow-runner.js";
import { StepExecutionError } from "./step-executor.js";

const failed = (detail?: string) =>
  new StepExecutionError(
    "goto",
    "operation_failed",
    "post_dispatch",
    [],
    detail,
  );

describe("navigation failure wording", () => {
  it("names the network cause the browser reported", () => {
    expect(
      navigationWhy(failed("goto failed: net::ERR_NAME_NOT_RESOLVED")),
    ).toBe("the host name could not be resolved (DNS)");
    expect(
      navigationWhy(failed("goto failed: net::ERR_CONNECTION_REFUSED")),
    ).toBe("the server refused the connection");
    expect(navigationWhy(failed("goto failed: timeout"))).toBe(
      "it took too long to respond",
    );
    expect(
      navigationWhy(failed("goto failed: net::ERR_CERT_DATE_INVALID")),
    ).toBe("its TLS certificate was rejected");
    expect(navigationWhy(failed("goto failed: net::ERR_ABORTED"))).toBe(
      "the browser reported net::ERR_ABORTED",
    );
    expect(navigationWhy(failed())).toBe("the browser could not load it");
  });
});

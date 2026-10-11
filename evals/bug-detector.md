# Bug detector evaluation

`scripts/detector-eval.ts` runs the bug detector (`--detect`) on the labelled
pages in `fixtures/site/detector-pages.ts`: 56 cases, 65 steps. Each case
plants one kind of bug on a page load or after a click, or is a clean control
written to tempt a false positive: input validation messages, help text about
errors, a JavaScript docs page that says "undefined", an explicit empty cart,
`$0` plans, a 401 session probe, and a page that loads for 1.2 seconds.
Cases are split into dev and held-out halves. Thresholds are tuned on dev
(midpoint of the maximum-F1 plateau) and reported on held-out.

```sh
bun scripts/detector-eval.ts --offline     # browser and exact-text checks, no calls
bun scripts/detector-eval.ts --repeat 3 --real   # live Jev; about $0.01
bun scripts/detector-demo.ts semantic      # fixture flows through the CLI
```

## Results (2026-10-11, jev-1.13.0)

At the shipped thresholds (error 0.6, stuck 0.4, empty 0.5, broken 0.65,
exact-text confirmation 0.5), all 65 steps:

| check                                             | TP  | FP  | FN  | precision | recall |
| ------------------------------------------------- | --- | --- | --- | --------- | ------ |
| console_error                                     | 1   | 0   | 0   | 1.00      | 1.00   |
| uncaught_exception                                | 2   | 0   | 0   | 1.00      | 1.00   |
| unhandled_rejection                               | 2   | 0   | 0   | 1.00      | 1.00   |
| http_error (document, fetch, XHR, image, network) | 6   | 0   | 0   | 1.00      | 1.00   |
| error_message                                     | 7   | 0   | 0   | 1.00      | 1.00   |
| stuck_loading                                     | 4   | 0   | 0   | 1.00      | 1.00   |
| empty_content                                     | 4   | 0   | 0   | 1.00      | 1.00   |
| broken_value                                      | 11  | 1   | 0   | 0.92      | 1.00   |

Held-out only: 18 of 18 buggy steps found, 1 of 15 clean steps flagged. The
false positive is a bakery page whose copy reads "Undefined-hours holidays";
Jev gives it broken_value 0.83.

Without the model (`--detect browser`), the browser checks score the same, and
exact strings alone find 5 of 11 broken values with one false positive (the
JavaScript docs page). With the model, an exact match must also get
broken_value of at least 0.5. That removes the docs false positive, and the
same matches on the Wikipedia and MDN pages below, without losing a true match.

Raw separation, which matters more than the tuned numbers on a corpus this
small:

- error_message: planted 0.94 to 0.99, everything else at most 0.31.
- stuck_loading: planted 0.51 to 0.94, everything else at most 0.11. The 3-second
  unchanged check rejects the page that finishes loading after 1.2 seconds.
- empty_content: planted 0.54 to 0.75, other pages at most 0.40, apart from
  stuck pages (tolerated). The margin is thin; the first prompt wording
  overlapped badly and was rewritten once.
- broken_value: planted fuzzy cases 0.80 to 0.99, clean at most 0.39 apart
  from the bakery trap.
- severity Score: 1.9 to 3.0 for errors and stuck pages, but 1.1 to 1.9 for
  broken values and 0.5 to 1.9, mostly with confidence near zero, for clean
  pages. It ranks findings; gating on it lost recall.

Stability: three fresh runs changed no decision; the largest probability change
was 0.08.

Cost: 195 calls, about 1,008 input tokens each, $0.0000423 per call
($0.0083 for three runs). Jev latency p50 79 ms, p90 106 ms, max 155 ms.
Detector overhead per step p50 356 ms, p90 401 ms, and about 3.4 s on a page
that looks like it is loading (the stuck wait).

Public pages (unlabelled): example.com, a Wikipedia article, Python and MDN
docs, Hacker News, and Sauce Demo raised no model findings. The GitHub
repository page raised a real `http_error` from a 4xx navigation payload, the
kind of noise `--detect-allow` is for.

Through the CLI (`scripts/detector-demo.ts`), the save, pay, and cart-total
flows were flagged on the clicking step and still passed. The clean
order flow and the existing login and checkout flows were not flagged. The
page-state cache meant 24 steps needed 11 detector calls.

## Caveats

The labels, pages, and prompts come from the same author, and the
empty_content prompt was revised after the first live run had shown both
splits. Treat the scores as a smoke test of separation, not as a measured
precision on real applications.

# Bug detector evaluation

`scripts/detector-eval.ts` runs the bug detector on the labelled pages in
`fixtures/site/detector-pages.ts`: 57 cases, 66 steps. Each case plants one
kind of bug on a page load or after a click, or is a clean control written to
tempt a false positive: input validation messages, help text about errors, a
JavaScript docs page that says "undefined", an explicit empty cart, `$0`
plans, a 401 session probe, and a page that loads for 1.2 seconds. Cases are
split into dev and held-out halves. Thresholds are tuned on dev (midpoint of
the maximum-F1 plateau) and reported on held-out.

```sh
bun scripts/detector-eval.ts --offline           # --detect browser; no calls
bun scripts/detector-eval.ts --repeat 3 --real   # --detect semantic, live Jev; about $0.01
bun scripts/detector-demo.ts semantic            # fixture flows through the CLI
```

## Results (2026-10-13, jev-1.13.0)

`--detect semantic` at the shipped thresholds (error 0.6, stuck 0.4, empty 0.5,
broken 0.65, exact-text confirmation 0.5), all 66 steps:

| check                                             | TP  | FP  | FN  | precision | recall |
| ------------------------------------------------- | --- | --- | --- | --------- | ------ |
| console_error                                     | 1   | 0   | 0   | 1.00      | 1.00   |
| uncaught_exception                                | 2   | 0   | 0   | 1.00      | 1.00   |
| unhandled_rejection                               | 2   | 0   | 0   | 1.00      | 1.00   |
| http_error (document, fetch, XHR, image, network) | 7   | 0   | 0   | 1.00      | 1.00   |
| error_message                                     | 7   | 0   | 0   | 1.00      | 1.00   |
| stuck_loading                                     | 4   | 0   | 0   | 1.00      | 1.00   |
| empty_content                                     | 4   | 0   | 0   | 1.00      | 1.00   |
| broken_value                                      | 11  | 1   | 0   | 0.92      | 1.00   |

Held-out only: 19 of 19 buggy steps found, 1 of 15 clean steps flagged. The
false positive is a bakery page whose copy reads "Undefined-hours holidays";
Jev gives it broken_value 0.77 to 0.82.

`--detect browser` finds the 12 browser faults with no false positives and
none of the page checks. It does not run the exact-text checks: on their own
they flag documentation (the JavaScript docs fixture, Wikipedia, MDN), so
`--detect semantic` keeps an exact match only when Jev gives broken_value of
at least 0.5. Exact strings then find 5 of 11 broken values with no false
positives; Jev finds the other 6.

Raw separation across three runs, which matters more than the tuned numbers
on a corpus this small:

- error_message: planted 0.93 to 0.99, everything else at most 0.32.
- stuck_loading: planted 0.56 to 0.94, everything else at most 0.12. The
  3-second unchanged check rejects the page that finishes loading after 1.2
  seconds.
- empty_content: planted 0.55 to 0.76, other pages at most 0.37, apart from
  stuck pages (tolerated). The margin is the thinnest; the first prompt
  wording overlapped badly and was rewritten once.
- broken_value: planted fuzzy cases 0.83 to 0.98, clean pages at most 0.40
  apart from the bakery trap. An error widget page reaches 0.51.
- severity Score: 1.9 to 3.0 for errors and stuck pages, but 1.1 to 1.9 for
  broken values and 0.5 to 2.0, mostly with confidence near zero, for clean
  pages. It ranks findings; gating on it lost recall.

Stability: across three fresh runs the largest probability change was 0.10.
One answer crossed 0.5 (the error widget's broken_value, 0.44 to 0.51); no
decision at the shipped thresholds changed.

Cost: 198 calls, about 1,009 input tokens each, $0.0000424 per call ($0.0084
for three runs). Jev latency p50 62 ms, p90 88 ms, max 204 ms. Detector
overhead per step p50 333 ms, p90 374 ms, and about 3.5 s on a page that looks
like it is loading (the stuck wait).

Public pages (unlabelled): example.com, a Wikipedia article, Python and MDN
docs, Hacker News, Sauce Demo, and a GitHub repository raised no Jev
findings. Sauce Demo and GitHub raised real `http_error`s from 4xx telemetry
and navigation payloads, the kind of noise `--detect-allow` is for.

## Caveats

The labels, pages, and prompts come from the same author, and the
empty_content prompt was revised after the first live run had shown both
splits. Treat the scores as a smoke test of separation, not as a measured
precision on real applications.

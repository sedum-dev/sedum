# Assertion engine

`@sedum-dev/core` exports `verify(page, judge, claim, options?)` and `measure(page, judge, claim, options?)`. Both read one settled, complete page digest and send the claim to `Judge.holds` once. The Judge returns `holds` and `contradicted` probabilities from one provider request.

The engine waits for `domcontentloaded` and a quiet page, then compares the digest's document, revision, and route with the quiet signal and a fresh page version. An empty page can be read again within the observation deadline. Incomplete, ambiguous, or oversized extraction produces a typed operational error before the Judge call. If the page changes while the Judge is answering, the result is a stale-observation error, never a claim verdict. The default observation budget is 4 seconds; callers can provide `observationTimeoutMs` and `signal`.

`verify` uses the SED-13 policy defaults `minP = 0.75`, `band = 0.15`, and contradiction cutoff `0.50`. A verify call can override `minP`. A score below `minP - band` fails; support in the band passes with `low_confidence`; support at or above `minP` passes. A passing result also gets `contradiction` when its contradiction score reaches `0.50`. A failed result retains its scores but has no flags. Comparisons use the unrounded scores. The result records both scores, effective policy, provider call metadata, and elapsed time.

`measure` returns both scores, call metadata, and elapsed time without a verdict or roll-up flags. It cannot gate a run. Every measure and every flagged or failed verify includes an excerpt of the exact digest sent to Judge, capped at 1,500 Unicode code points including the truncation marker. Clean verifies omit it. This excerpt is allowed page text and is **not redacted**; SED-39 owns any later decision to persist or report it.

`AssertionEngineError.code` distinguishes missing, ambiguous, incomplete, oversized, stale, timed-out, canceled, browser, and provider failures. These are operational errors rather than failed assertions. Its JSON form carries only the code and a safe message.

The page digest limit remains 4,096 Unicode code points, and the TypeSafe adapter keeps its 64 KiB serialized request limit. SED-25 does not expand either limit. The PoC Wikipedia article exceeds them and currently fails operationally; [SED-81](https://linear.app/sedum/issue/SED-81/design-long-page-judge-evidence-and-restore-wikipedia-assertion) owns long-page evidence and positive Wikipedia acceptance.

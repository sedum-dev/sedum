# Probabilistic testing

> **Probabilistic testing** means every check a model makes returns how likely
> it is to hold, and the verdict comes from comparing that probability with a
> threshold you set. The test still passes or fails, but you can see how sure
> it was.

This page explains why Sedum works this way, how scores become verdicts and
exit codes, and how to tune it.

## Every AI test is already probabilistic

When a model reads a page and decides whether "a list of products with prices
is shown", it is making a judgment, and it can be more or less sure. That is
true for every tool that uses a model to test a page.

Most tools ask the model for a plain yes or no and treat the answer as a fact.
The uncertainty does not go away. It shows up later as a test that passes on
Monday and fails on Tuesday with nothing changed and no explanation.

So the choice is not between probabilistic and deterministic tests. It is
between showing the uncertainty and hiding it. Sedum shows it.

## What Sedum measures

A `verify` step asks the model two separate questions about the page:

- **Holds:** how likely is it that the claim is true?
- **Contradicted:** how likely is it that the page shows evidence against it?

These are not two ends of one scale. A page can support a claim and contradict
it at once, for example a cart page that says "Your cart is empty" while the
cart badge shows 1. Asking both questions catches that.

Finding elements is probabilistic too. For "click the login button", the model
scores every candidate on the page and always has the option of choosing none
of them. Sedum acts only when the chosen element clears both a confidence
threshold and a clear margin over the runner-up. Otherwise the step fails with
the ranked candidates in the report, rather than clicking the nearest match
and hoping.

## From scores to verdicts

The defaults for a `verify` step are:

| Holds score     | Verdict                |
| --------------- | ---------------------- |
| 0.75 or higher  | pass                   |
| 0.60 up to 0.75 | pass, `low_confidence` |
| below 0.60      | fail                   |

A pass also gets the `contradiction` flag when the contradicted score is 0.50
or higher. A failed step keeps its scores but has no flags. Comparisons use the
exact scores, not rounded ones.

A flagged pass is still a pass. The flags tell you where to look, without
breaking the build for a check that probably holds.

## From verdicts to exit codes

CI needs a clear answer, so every run ends in one exit code:

| Exit | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Every test passed. Flagged passes count as passes by default.   |
| `1`  | A test failed.                                                  |
| `2`  | Tests passed, but some were flagged. Only with `--strict`.      |
| `3`  | Sedum could not reach a verdict, for example a missing browser. |

`--strict` changes only the exit code and the JUnit mapping. The verdicts and
flags in the result stay the same, so a report reads the same whichever mode
you ran in.

This gives you three outcomes instead of two. A failure means the page did
not show what the test expected. A flag means the model was not sure. Exit `3`
means Sedum could not check at all. Your CI can block on the first, warn on the
second, and retry the third.

## Why this is better

- **"Not sure" is its own answer.** A normal test reports "the product broke"
  and "the test could not tell" the same way. Sedum keeps them apart, so people
  look at real failures first.
- **You can see a check getting weaker.** Every run records the scores. A claim
  that slides from 0.97 to 0.81 to 0.64 is telling you something before it
  fails. A yes or no answer throws that away.
- **Cheap is safe.** A fast, inexpensive model is only trustworthy if it says
  when it is unsure. Scores let Sedum accept confident answers and flag the
  rest, which is what makes it safe to ask a model on every step of every run.
- **You set the trade-off.** Every test suite balances false alarms against
  missed bugs. Brittle selectors cause false alarms; loose assertions miss
  bugs. A threshold turns that balance into one setting you can see and change.
- **Bad tests show up.** A high contradicted score usually means the sentence
  is ambiguous, or the page is. The fix is often to rewrite the step, and the
  report tells you which step.

## Tuning thresholds

Set the thresholds in `sedum.config.yaml`. They apply to every `verify` step in
the project:

```yaml
thresholds:
  verify: 0.75 # a holds score at or above this passes cleanly
  lowConfidenceBand: 0.15 # this far below `verify` still passes, flagged
  contradiction: 0.5 # a contradicted score at or above this flags a pass
```

- Raise `verify` to fail more often on weak evidence. You will catch more bugs
  and see more false alarms.
- Narrow `lowConfidenceBand` to turn borderline passes into failures instead of
  flags.
- Run with `--strict` in CI if any flag should block a merge.

The thresholds used for finding elements and for classifying steps are safety
gates and cannot be changed.

## Observing without a verdict

A step that starts with `measure`, `note`, or `observe` records both scores
without deciding the test:

```yaml
steps:
  - measure the shipping cost is shown before checkout
```

Use it to see how a new claim scores across a few runs before you turn it into
a `verify`, or to track something you want to watch but not gate on.

## Reading the scores

For every failed or flagged step, the Markdown report shows the holds score
against the fail and pass lines, the contradicted score against its cutoff,
and the page text the model judged. When an element could not be found, it
lists the ranked candidates, including "no match". See
[CLI commands](cli.md) for the HTML, Markdown, JSON, and JUnit reports.

## Writing claims that score well

A claim scores clearly when it names something a person could point to on the
page.

| Scores unclearly      | Scores clearly                                  |
| --------------------- | ----------------------------------------------- |
| verify it worked      | verify the page says "Thank you for your order" |
| verify the cart is ok | verify the cart lists 2 items                   |
| verify prices         | verify every product shows a price in dollars   |

If a step keeps getting `low_confidence` or `contradiction`, read the page
text in the report. Usually the claim is vague, or the page really does say
two things.

## What the scores are not

The scores are the model's confidence, not measured frequencies. A score of
0.9 does not yet mean the claim is right 9 times out of 10. The default
thresholds are set to be safe, and the flags exist so that uncertain answers
reach a person. Treat the numbers as a ranking of how sure each check was, and
use the thresholds to decide what to do about it.

## Related

- [Plain-English browser tests](plain-english-tests.md): the basics.
- [Assertion engine](assertion-engine.md): the exact verdict rules.
- [Project configuration](configuration.md): all `sedum.config.yaml` keys.

---
"@sedum-dev/core": patch
---

Improve live site control discovery and action freshness. Explicit ARIA labels
can name hidden referenced text, overlong controls keep bounded visible names
without poisoning unrelated choices, and visible targets are hit tested before
scrolling. A pre-dispatch stale action can be resolved once against the current
page; an action that may have started is never replayed. Dynamic candidate
pagination preserves one snapshot while fresh target revalidation protects
actions. Bounded empty-page and stale reads handle delayed navigation.
Assertion digests include rendered noneditable combobox selections, and a
same-route page revision can retain a judgment only if a fresh complete
digest is identical.
Control discovery also accepts placeholder and title fallback names, and
ranked-story phrasing retains the repeated-link safety check.
Empty fill candidate scans briefly wait for late labels.

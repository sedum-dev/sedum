---
"@sedum-dev/core": patch
---

Check exact text without the Judge. Quoted text asks for an exact check on the page's visible text: `verify the text "Total" is not shown`, `verify "Add debt" appears once`, `verify "{{name}}" appears exactly 2 times`, `verify the text "A" or "B" is shown`, and `verify the page URL contains "/sign-up"`. Unquoted `the text X is shown` passes at once when X is on the page, in any letter case, and otherwise goes to the Judge as before, since the author may paraphrase. These checks read text the same way the Judge does, with no 4,096-character limit.

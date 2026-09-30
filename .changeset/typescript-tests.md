---
"@sedum-dev/core": minor
"@sedum-dev/reporters": minor
"sedum-cli": minor
---

Write tests in TypeScript. A `*.test.ts` file declares tests with `test(title, options, async ({ page, context, ai, env, testInfo }) => { ... })`. Plain-English steps run with `await ai("click the Login button")`; values go in a second argument (`ai("type {{email}} into the Email field", { email })`) and `secret()` keeps a value out of model input and reports. `ai.group` names a block of steps, `ai.extract` reads an element's text, and Playwright's `page`, `context`, and `expect` work between steps. `sedum run`, `list`, and `validate` discover `*.test.ts` beside `*.test.yaml`; `validate` classifies the literal sentences in `ai(...)` calls and warns about sentences built at run time. `sedum run --id <id>` selects tests by exact id, and reports name a TypeScript test by its file and title and rerun it with `--id`. `sedum init` now writes a TypeScript example.

---
"@sedum-dev/core": minor
"@sedum-dev/reporters": minor
"sedum-cli": minor
---

Add `ai.goal(goal, values?, options?)` to TypeScript tests for bounded planner-driven
click and type execution. Accepted planner completion resolves without hidden
independent verification; semantic `ai("verify ...")` steps and Playwright
assertions remain separately authored. Report planner completion explicitly,
support per-invocation automatic Faker data, and prevent automatic whole-test
retries after a goal enters planning. Set `options.generateData: false` to disable
automatic generation for one goal and use only supplied or remembered values.

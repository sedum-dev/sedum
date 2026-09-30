---
"sedum-cli": patch
"@sedum-dev/reporters": patch
---

Print `npx sedum …` in hints when sedum runs from a project's `node_modules` or through npx, as the README installs it. Previously every "Next steps", "rerun" and "Fix" hint said bare `sedum …`, which fails with "command not found" for a local install. This covers terminal output and the rerun hints in the HTML, Markdown and JUnit reports. A global install keeps `sedum`.

---
title: "Agent skills"
---

Teach Claude Code or Codex to investigate Sedum failures and identify flaky,
slow, or regressing tests without fetching every run's full report.

The skill lives in the **Sedum core repository**, alongside the CLI it uses:
[`investigating-sedum-tests/SKILL.md`](https://github.com/sedum-dev/sedum/tree/main/.agents/skills/investigating-sedum-tests).
It works with hosted or self-hosted Sedum Cloud. Cloud supplies authenticated
run history; installing the skill does not install a server, create an account,
or grant access to a project. No MCP server is required.

## Install in Claude Code and Codex

Run this from the project where your agent works:

```sh
npx skills add sedum-dev/sedum --skill investigating-sedum-tests -a claude-code -a codex
```

This uses the third-party [skills CLI](https://github.com/vercel-labs/skills).
Its current documentation requires Node.js 22.20 or newer; use the manual
installation below if you do not want another installer. Remove either `-a`
option to install for only one agent. Add `-g` for a personal installation
available across projects instead of a project-local installation.

The installer discovers the canonical `.agents/skills` source in the Sedum
repository and installs it into the selected agents' skill locations. Choose
Project when prompted for scope, unless you want a personal installation.
Review the installation summary and any overwrite warning: accepting replacement
can discard local customizations. Do not install a second copy manually as well.

## Copy or download manually

The skill is one Markdown file, with no scripts or dependencies to copy. Open
the [raw SKILL.md](https://raw.githubusercontent.com/sedum-dev/sedum/main/.agents/skills/investigating-sedum-tests/SKILL.md),
copy its **entire contents, including YAML frontmatter**, and save it at one
of these paths:

| Agent       | Project-local path                                  | Personal path                                         |
| ----------- | --------------------------------------------------- | ----------------------------------------------------- |
| Claude Code | `.claude/skills/investigating-sedum-tests/SKILL.md` | `~/.claude/skills/investigating-sedum-tests/SKILL.md` |
| Codex       | `.agents/skills/investigating-sedum-tests/SKILL.md` | `~/.agents/skills/investigating-sedum-tests/SKILL.md` |

Or use this shell snippet from your project. Choose **one** destination; change
it to the corresponding personal path above for a user-wide installation:

```sh
# Claude Code:
skill_dir=.claude/skills/investigating-sedum-tests
# For Codex, use this instead:
# skill_dir=.agents/skills/investigating-sedum-tests

mkdir -p "$skill_dir"
if [ -e "$skill_dir/SKILL.md" ]; then
  printf 'Skill already exists; review it before replacing it.\n'
else
  curl --fail --location \
    https://raw.githubusercontent.com/sedum-dev/sedum/main/.agents/skills/investigating-sedum-tests/SKILL.md \
    --output "$skill_dir/SKILL.md"
fi
```

Project-local skills can be committed to your own repository so the team shares
the same instructions. For reproducible installs, replace `main` in the download
URL with a reviewed Sedum commit or tag. Copies do not update automatically;
review changes before replacing an existing skill.

## Connect Sedum and try it

Installing the skill does **not** install the Sedum CLI. Sedum requires Node.js
20.19 or newer, independently of the optional skills installer's higher requirement.
If the project does not already depend on `sedum-cli`, install it first:

```sh
npm install -D sedum-cli
```

The commands below use that project's installed CLI. Without it, `npx sedum`
can download an unrelated npm package named `sedum`. Check that your installed
version supports Cloud result reads, then sign in yourself:

```sh
npx sedum tests stats --help
npx sedum auth login --url https://your-cloud.example
npx sedum auth status
```

Your account needs membership in the organization/project, and that project
needs uploaded runs. The skill uses the saved project or explicit CLI overrides.
Never paste tokens into an agent conversation or put credentials in the skill.
See [Cloud result reads](https://docs.sedum.dev/cli#cloud-result-reads) for commands and limits.

Start a fresh agent session after installation if the skill is not discovered.
In **Claude Code**, invoke `/investigating-sedum-tests`; in **Codex**, select it
with `/skills` or mention `$investigating-sedum-tests`. Then ask, for example:

```text
Investigate the failing test in my latest result.json. Compare its exact test ID
with the last seven days on main. Show evidence and uncertainty; do not edit code.
```

```text
Review the last seven days on main. Shortlist the top five tests to improve based
on failures, recovered retries, retry overhead, and duration regressions. Include
sample counts and recommended next checks. Do not modify tests or create issues.
```

The skill guides bounded investigation that is **read-only by default**. Changes,
scheduling, and publishing actions such as posting issues require separate
authorization. Retry recovery alone does not establish a root cause.

Agent discovery conventions are documented by
[Claude Code](https://code.claude.com/docs/en/skills) and
[Codex](https://developers.openai.com/codex/skills/).

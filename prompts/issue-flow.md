---
description: Work a GitHub issue end-to-end from research to PR
argument-hint: "<issue-url-or-#number>"
---

Work this issue end-to-end.

Issue / instructions:
$ARGUMENTS

If no issue URL or issue number was provided above, stop and ask me for one before doing anything else.

1. **Research** - view and understand the issue and instructions above.

2. **Branch** - create a branch with `git checkout -b <type>/<short-slug>` matching the issue.

3. **Implement** - make the minimal change that satisfies every acceptance criterion in the issue. No scope creep.

4. **Check** - before committing, go through the issue's acceptance criteria line by line. Close any gaps now, including required docs, config examples, and README mentions. Do not proceed until every criterion is met.

5. **Commit** - stage the relevant changes and write a conventional commit. Include `Closes #<n>` in the body when the issue number is known.

6. **Push** - push the branch.

7. **PR** - open a pull request.

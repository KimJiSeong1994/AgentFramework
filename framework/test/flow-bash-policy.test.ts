// AC0.4 bash half: the read-only argv policy of the planning boundary, table-driven.
import { expect, test } from "bun:test"
import { bashPolicyProblem, tokenize } from "../src/flow/bash-policy.ts"

const DENIED = [
  "ls && rm -rf src", "ls; rm x", "cat a | sh", "echo x > f", "ls $(rm x)", "ls `rm x`",
  "find . -delete", "find . -exec rm {} +",
  "rg --pre sh x", "rg --pre=sh x", "rg --hostname-bin=sh x", "rg --hostname-bin sh x", "rg -z x", "rg --search-zip x",
  "git diff --output=f", "git -c core.pager=sh log", "git -C .. status", "git log --ext-diff", "git show --textconv x",
  "git push", "git checkout x", "git --git-dir=x status",
  "tail -f log", "tail --follow=name log", "tail -10f log", "tail -nF log", "tail -Fn5 log", "file -C -m x", "file --compile x",
  "python3 -c 1", "sh -c ls", "rm x", "echo \"unbalanced", "ls \\\n rm", "cat a\trm", "",
]
const ALLOWED = [
  "git diff", "git log --oneline -5", 'rg -n "foo bar" src', "ls -la src", "cat README.md", "head -50 x.py",
  "wc -l x", "tail -20 log", "tail -n 5 log", "file x.py", "git status", "git show HEAD:README.md", "pwd", "grep -rn foo src", "stat x", "file x", "git rev-parse HEAD",
]

test("denied commands are refused with a reason", () => {
  for (const c of DENIED) {
    const p = bashPolicyProblem(c)
    if (!p) throw new Error(`should refuse: ${JSON.stringify(c)}`)
  }
})

test("read-only commands are allowed", () => {
  for (const c of ALLOWED) expect([c, bashPolicyProblem(c)]).toEqual([c, null])
})

test("tokenizer keeps quoted spaces and never expands", () => {
  expect(tokenize('rg -n "foo bar" src')).toEqual(["rg", "-n", "foo bar", "src"])
  expect(tokenize("cat 'a b'")).toEqual(["cat", "a b"])
  expect(tokenize('cat "a')).toBeNull()
})

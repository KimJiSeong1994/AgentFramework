import { expect, test } from "bun:test"
import { containsSecret } from "../src/security/secrets.ts"

test("credential URL detection retains embedded scheme and token coverage", () => {
  for (const text of [
    "https://user:password@example.test", "prefix https://user:password@example.test suffix",
    "git+https://user:password@example.test", "(custom_2://name:password@host)",
    "password=long-secret-value", "Bearer abc123", "-----BEGIN RSA PRIVATE KEY-----",
  ]) expect(containsSecret(text)).toBe(true)
  for (const text of ["https://example.test", "https://example.test/path", "plain documentation", "token=short"])
    expect(containsSecret(text)).toBe(false)
})

test("bounded non-secret source words are scanned without quadratic scheme backtracking", () => {
  const source = "x".repeat(128 * 1024)
  const started = performance.now()
  for (let i = 0; i < 4; i++) expect(containsSecret(source)).toBe(false)
  // Generous compared with the linear scan; the former unanchored scheme repeated at every byte.
  expect(performance.now() - started).toBeLessThan(1000)
  expect(containsSecret(`${source} https://user:password@example.test`)).toBe(true)
})

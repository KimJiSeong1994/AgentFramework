// Shared secret-detection regex. Kept narrow and dependency-free: it is a best-effort heuristic, not a
// cryptographic guarantee. Callers must not treat a false negative as an authorization decision.
export const SECRET_PATTERN =
  /apikey_[a-z0-9_]{12,}|\bsk-[a-z0-9_-]{12,}|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\bAIza[a-z0-9_-]{20,}|\bBearer\s+\S+|(?:api[_-]?key|password|secret|token|credential)\s*[:=]\s*["']?[^\s"']{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b\w+:\/\/[^\s/:]+:[^\s/@]+@/i

export function containsSecret(text: string): boolean {
  return SECRET_PATTERN.test(text)
}

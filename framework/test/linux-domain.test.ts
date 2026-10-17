import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import {
  authenticateLinuxVerification, isCurrentLinuxVerifierReference, linuxBootEpochMatches,
  linuxRootFileMetadataTrusted, linuxRootPathMetadataTrusted, linuxUserNamespaceMapTrusted,
  linuxVerifierProfileShapeValid, verifyLinuxVerificationCrypto,
} from "../src/hosts/linux-domain.ts"
import type { VerificationReference, VerificationResult } from "../src/orchestration/verifier.ts"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const bootID = "11111111-1111-4111-8111-111111111111"
const ticket = "2".repeat(32)
const tree = "a".repeat(40)
const JOURNAL_DROPIN_PATH = "/etc/systemd/journald.conf.d/otter-verifier.conf"
const reference: VerificationReference = {
  kind: "verifier", executionID: "execution-1", profile: "linux-single-use", invocationID: ticket,
  inputSnapshotID: tree, inputDigest: createHash("sha256").update(tree).digest("hex"),
  deadlineAt: 2_000_000_000_000, maxOutputChars: 128, unit: "otter-verifier.service", bootID,
}
const profileFiles = [
  "/usr/local/libexec/otter-verifier/gate.py",
  "/usr/local/libexec/otter-verifier/runner.py",
  "/usr/local/libexec/otter-verifier/client.py",
  "/etc/systemd/system/otter-verifier.service",
  "/etc/systemd/system/otter-verifier-gate.service",
  "/etc/systemd/system/otter.slice",
  "/etc/polkit-1/rules.d/90-otter-verifier.rules",
  "/etc/sudoers.d/00-otter-verifier-deny",
  JOURNAL_DROPIN_PATH,
]

function signedResult(options: {
  receipt?: Record<string, unknown>
  mutate?: (result: VerificationResult) => VerificationResult
} = {}): VerificationResult {
  const output = "verification output"
  const payload = options.receipt ?? {
    schema: "otter.linux-verifier.retirement.v1",
    reference,
    binding: {
      unit: "otter-verifier.service", bootID, systemdInvocationID: "3".repeat(32), mainPID: 431,
      startTimeTicks: 9001, cgroupPath: "/otter.slice/otter-verifier.service", device: "42", inode: "991",
    },
    retirement: { kind: "held-deleted-journal", messageID: "7ad2d189f7e94e70a38c781354912448" },
    result: {
      parentExit: 0, timedOut: false, cancelled: false, inputIntegrity: "unchanged",
      outputSha256: createHash("sha256").update(output, "utf8").digest("hex"),
    },
  }
  const receipt = JSON.stringify(payload)
  const signature = sign(null, Buffer.from(receipt, "utf8"), privateKey).toString("base64")
  const result: VerificationResult = {
    profile: "linux-single-use", parentExit: 0, timedOut: false, cancelled: false,
    isolationEstablished: true, domainState: "empty", integrity: "unchanged", output,
    proof: { reference, evidence: "authenticated Linux gate retirement", receipt, signature },
  }
  return options.mutate ? options.mutate(result) : result
}

function reSign(payload: Record<string, unknown>): VerificationResult {
  const result = signedResult()
  const receipt = JSON.stringify(payload)
  return {
    ...result,
    proof: { ...result.proof!, receipt, signature: sign(null, Buffer.from(receipt, "utf8"), privateKey).toString("base64") },
  }
}

test("pure Ed25519 receipt validation binds reference, result, output and native receipt schema", () => {
  const valid = signedResult()
  expect(verifyLinuxVerificationCrypto(valid, reference, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(true)

  const changedOutput = { ...valid, output: "tampered output" }
  expect(verifyLinuxVerificationCrypto(changedOutput, reference, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  expect(verifyLinuxVerificationCrypto(valid, { ...reference, executionID: "other-execution" }, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  expect(verifyLinuxVerificationCrypto({ ...valid, proof: { ...valid.proof!, signature: "A".repeat(88) } }, reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  expect(verifyLinuxVerificationCrypto({ ...valid, output: "x".repeat(reference.maxOutputChars + 1) }, reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)

  const payload = JSON.parse(valid.proof!.receipt!) as Record<string, unknown>
  expect(verifyLinuxVerificationCrypto(reSign({ ...payload, schema: "otter.unknown.receipt.v9" }), reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  const wrongBootBinding = { ...(payload.binding as Record<string, unknown>), bootID: "44444444-4444-4444-8444-444444444444" }
  expect(verifyLinuxVerificationCrypto(reSign({ ...payload, binding: wrongBootBinding }), reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  const wrongOutputDigest = {
    ...(payload.result as Record<string, unknown>), outputSha256: "f".repeat(64),
  }
  expect(verifyLinuxVerificationCrypto(reSign({ ...payload, result: wrongOutputDigest }), reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
  const wrongReceiptReference = { ...(payload.reference as Record<string, unknown>), inputDigest: "f".repeat(64) }
  expect(verifyLinuxVerificationCrypto(reSign({ ...payload, reference: wrongReceiptReference }), reference,
    publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false)
})

test("signed journal retirement recognizes only domain terminal events, never parent exit alone", () => {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const payload = JSON.parse(signedResult().proof!.receipt!) as Record<string, unknown>
  expect(verifyLinuxVerificationCrypto(
    reSign({ ...payload, retirement: { kind: "held-empty" } }), reference, pem,
  )).toBe(false)
  for (const messageID of [
    "9d1aaa27d60140bd96365438aad20286",
    "7ad2d189f7e94e70a38c781354912448",
    "d9b373ed55a64feb8242e02dbe79a49c",
  ]) {
    const result = reSign({ ...payload, retirement: { kind: "held-deleted-journal", messageID } })
    expect(verifyLinuxVerificationCrypto(result, reference, pem)).toBe(true)
    expect(authenticateLinuxVerification(result, reference)).toBe(false)
  }
  for (const messageID of ["98e322203f7a4ed290d09fe03c09fe15", "39f53479d3a045ac8e11786248231fbf", "unknown"]) {
    expect(verifyLinuxVerificationCrypto(
      reSign({ ...payload, retirement: { kind: "recovered-journal", messageID } }), reference, pem,
    )).toBe(false)
  }
})

test("crypto helper permits only conservative integrity and exact result flags", () => {
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const signedUnchanged = signedResult()
  expect(verifyLinuxVerificationCrypto({ ...signedUnchanged, integrity: "changed" }, reference, pem)).toBe(true)
  expect(verifyLinuxVerificationCrypto({ ...signedUnchanged, integrity: "unknown" }, reference, pem)).toBe(true)
  expect(verifyLinuxVerificationCrypto({ ...signedUnchanged, timedOut: true }, reference, pem)).toBe(false)
  expect(verifyLinuxVerificationCrypto({ ...signedUnchanged, isolationEstablished: false }, reference, pem)).toBe(false)
  const payload = JSON.parse(signedUnchanged.proof!.receipt!) as Record<string, unknown>
  const changedReceipt = reSign({ ...payload, result: { ...(payload.result as object), inputIntegrity: "changed" } })
  expect(verifyLinuxVerificationCrypto({ ...changedReceipt, integrity: "unchanged" }, reference, pem)).toBe(false)
})

test("root profile path metadata rejects foreign owners, writable modes and symlink components", () => {
  const regularRootFile = { uid: 0, mode: 0o100644, isFile: true, isDirectory: false, isSymbolicLink: false }
  expect(linuxRootPathMetadataTrusted(regularRootFile, "file")).toBe(true)
  expect(linuxRootPathMetadataTrusted({ ...regularRootFile, uid: 1000 }, "file")).toBe(false)
  expect(linuxRootPathMetadataTrusted({ ...regularRootFile, mode: 0o100664 }, "file")).toBe(false)
  expect(linuxRootPathMetadataTrusted({ ...regularRootFile, mode: 0o100666 }, "file")).toBe(false)
  expect(linuxRootPathMetadataTrusted({ ...regularRootFile, isSymbolicLink: true }, "file")).toBe(false)
  expect(linuxRootPathMetadataTrusted({ ...regularRootFile, isDirectory: true }, "file")).toBe(false)
  const rootDirectory = { uid: 0, mode: 0o40755, isFile: false, isDirectory: true, isSymbolicLink: false }
  expect(linuxRootPathMetadataTrusted(rootDirectory, "directory")).toBe(true)
  expect(linuxRootPathMetadataTrusted({ ...rootDirectory, mode: 0o40775 }, "directory")).toBe(false)
  expect(linuxRootPathMetadataTrusted({ ...rootDirectory, isSymbolicLink: true }, "directory")).toBe(false)
})

test("only the exact v2 profile shape with a canonical boot epoch and journal drop-in hash is accepted", () => {
  const profile = {
    schema: "otter.linux-verifier.profile.v2",
    bootEpoch: bootID,
    unit: "otter-verifier.service",
    controllerUID: 1000,
    verifierUID: 1001,
    publicKeyPem: "ed25519 public key",
    files: Object.fromEntries(profileFiles.map(path => [path, "a".repeat(64)])),
    qualified: false,
  }
  expect(linuxVerifierProfileShapeValid(profile)).toBe(true)
  expect(linuxVerifierProfileShapeValid({ ...profile, schema: "otter.linux-verifier.profile.v1" })).toBe(false)
  expect(linuxVerifierProfileShapeValid({ ...profile, bootEpoch: "11111111111141118111111111111111" })).toBe(false)
  const withoutDropin = Object.fromEntries(
    Object.entries(profile.files).filter(([path]) => path !== JOURNAL_DROPIN_PATH),
  )
  expect(linuxVerifierProfileShapeValid({ ...profile, files: withoutDropin })).toBe(false)
  expect(linuxVerifierProfileShapeValid({ ...profile, extra: true })).toBe(false)
})

test("boot epoch comparator fails closed off Linux", () => {
  if (process.platform !== "linux") expect(linuxBootEpochMatches()).toBe(false)
})

test("namespace maps must be the single complete initial-namespace mapping", () => {
  for (const map of ["0 0 4294967295\n", "         0          0 4294967295\n"]) {
    expect(linuxUserNamespaceMapTrusted(map)).toBe(true)
  }
  for (const map of [
    "0 100000 65536\n", "0 0 65536\n", "0 0 4294967295\n1 1 1\n", "0 0 4294967295 extra\n",
    "\n0 0 4294967295\n", "0 0 4294967295\n\n", "",
  ]) expect(linuxUserNamespaceMapTrusted(map)).toBe(false)
})

test("bounded root-file metadata refuses wrong type, ownership, write mode and over-limit size", () => {
  const rootFile = { uid: 0, mode: 0o100644, isFile: true, isDirectory: false, isSymbolicLink: false, size: 128 }
  expect(linuxRootFileMetadataTrusted(rootFile, 128)).toBe(true)
  expect(linuxRootFileMetadataTrusted({ ...rootFile, uid: 501 }, 128)).toBe(false)
  expect(linuxRootFileMetadataTrusted({ ...rootFile, isFile: false }, 128)).toBe(false)
  expect(linuxRootFileMetadataTrusted({ ...rootFile, mode: 0o100666 }, 128)).toBe(false)
  expect(linuxRootFileMetadataTrusted({ ...rootFile, size: 129 }, 128)).toBe(false)
  expect(linuxRootFileMetadataTrusted({ ...rootFile, size: Number.MAX_SAFE_INTEGER + 1 }, 128)).toBe(false)
})

test("current-boot reference checks reject stale Linux receipts", () => {
  const actualBoot = process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : ""
  const staleBoot = actualBoot === bootID ? "44444444-4444-4444-8444-444444444444" : bootID
  expect(isCurrentLinuxVerifierReference({ ...reference, bootID: staleBoot })).toBe(false)
})

test("explicit test key never becomes the native Linux authority", () => {
  const proof = signedResult()
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
  expect(verifyLinuxVerificationCrypto(proof, reference, pem)).toBe(true)
  expect(authenticateLinuxVerification(proof, reference)).toBe(false)
  expect(authenticateLinuxVerification({ ...proof, output: "tampered" }, reference)).toBe(false)
})

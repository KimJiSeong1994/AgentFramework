import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { attachAdmission, admissionEpoch, effectiveHold, holdAdmission } from "../src/sessions/admission.ts"
import { getOpenCodeRuntime } from "../src/hosts/opencode-runtime.ts"
import { sessionDir } from "../src/state/store.ts"
import { fakeClient, makeDeps, tempWorktree } from "./guards-helpers.ts"

let wt: ReturnType<typeof tempWorktree>
beforeEach(() => { wt = tempWorktree() })
afterEach(() => wt.cleanup())

const PROOF = { workflowQuiescent: true as const, evidence: "crash-boundary fixture has no dispatched work", workflowID: null, revision: null }

type CrashBoundary = "before-temp-create" | "after-file-fsync-before-rename" | "after-rename-before-dir-fsync" | "after-dir-fsync" | "after-durable-clear-before-token-publication"
type CrashCase = { name: string; boundary: CrashBoundary; fresh: boolean }

const crashCases: CrashCase[] = [
  { name: "before create/hold temp write", boundary: "before-temp-create", fresh: false },
  { name: "after hold file fsync and before rename", boundary: "after-file-fsync-before-rename", fresh: false },
  { name: "after hold rename and before directory fsync", boundary: "after-rename-before-dir-fsync", fresh: false },
  { name: "after hold directory fsync", boundary: "after-dir-fsync", fresh: false },
  { name: "after durable clear and before token publication", boundary: "after-durable-clear-before-token-publication", fresh: true },
]

describe("session admission process-crash durability", () => {
  test.each(crashCases)("$name leaves no admission or dispatch authority", async ({ name, boundary, fresh }) => {
    const sid = `crash_${boundary.replaceAll("-", "_")}`
    const client = fakeClient({ promptAsync: true })
    ;(client.session as any).get = async ({ path }: { path: { id: string } }) => ({
      data: { id: path.id, directory: wt.worktree, time: { created: 1, updated: 2 } },
    })
    const host = getOpenCodeRuntime(makeDeps(client, wt.worktree))

    let priorMarker: string | undefined
    if (!fresh) {
      const seeded = attachAdmission(host, sid, { engine: "opencode" })
      holdAdmission(wt.worktree, sid, "crash-boundary-seed")
      seeded.release(PROOF)
      priorMarker = readFileSync(join(sessionDir(wt.worktree, sid), "restore-hold.json"), "utf8")
    } else {
      expect(existsSync(sessionDir(wt.worktree, sid))).toBe(false)
    }

    const targetPath = fresh
      ? join(sessionDir(wt.worktree, sid), "metadata.json")
      : join(sessionDir(wt.worktree, sid), "restore-hold.json")
    const receiptPath = join(wt.stateHome, `admission-crash-${boundary}.json`)
    const childEnv = {
      ...process.env,
      LCA_STATE_HOME: wt.stateHome,
      SESSION_CRASH_ADMISSION_URL: new URL("../src/sessions/admission.ts", import.meta.url).href,
      SESSION_CRASH_HELPERS_URL: new URL("./guards-helpers.ts", import.meta.url).href,
      SESSION_CRASH_RUNTIME_URL: new URL("../src/hosts/opencode-runtime.ts", import.meta.url).href,
      SESSION_CRASH_TARGET: targetPath,
      SESSION_CRASH_RECEIPT: receiptPath,
      SESSION_CRASH_BOUNDARY: boundary,
      SESSION_CRASH_WORKTREE: wt.worktree,
      SESSION_CRASH_SESSION: sid,
    }
    const child = Bun.spawn([process.execPath, "-e", crashChildProgram], {
      cwd: process.cwd(),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderrPromise = new Response(child.stderr).text()
    let recovered: ReturnType<typeof attachAdmission> | undefined
    try {
      const exitCode = await child.exited
      const stderr = await stderrPromise
      expect(exitCode, `${name}: child did not die at the requested boundary; stderr=${stderr}`).toBe(137)
      expect(existsSync(receiptPath), `${name}: child did not emit a reached-boundary receipt; stderr=${stderr}`).toBe(true)
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        boundary: CrashBoundary
        actualOwnedPID: number
        targetPath: string
        sessionID: string
        stage: string
      }
      expect(receipt).toEqual({ boundary, actualOwnedPID: child.pid, targetPath, sessionID: sid, stage: boundary })

      if (fresh) {
        expect(JSON.parse(readFileSync(targetPath, "utf8"))).toMatchObject({ engine: "opencode", held: false })
      } else {
        if (priorMarker === undefined) throw new Error("held crash fixture has no original marker")
        expect(JSON.parse(readFileSync(targetPath, "utf8"))).toMatchObject({ sid, held: true })
        if (boundary === "before-temp-create" || boundary === "after-file-fsync-before-rename") {
          expect(readFileSync(targetPath, "utf8")).toBe(priorMarker)
        } else {
          expect(readFileSync(targetPath, "utf8")).not.toBe(priorMarker)
        }
      }

      // This is the real next-process admission path: a killed owner cannot
      // transfer an initial or Resume token, even when a clear reached disk.
      recovered = attachAdmission(host, sid, { engine: "opencode" })
      expect(admissionEpoch(wt.worktree, sid)).toBeUndefined()
      expect(effectiveHold(wt.worktree, sid)).toBe(true)
      expect(recovered.metadata.held).toBe(true)
      expect(() => recovered!.clearHold({ authorized: true, reason: "new-session" })).toThrow()
      expect(() => recovered!.clearHold({ authorized: true, reason: "explicit-resume" })).toThrow("validated explicit Resume proof")
      expect(admissionEpoch(wt.worktree, sid)).toBeUndefined()
      expect(effectiveHold(wt.worktree, sid)).toBe(true)
      expect(host.runs.status().claim).toBeUndefined()
      expect(host.runs.status().executions).toHaveLength(0)
      expect(client.calls.filter(call => call.method === "prompt" || call.method === "promptAsync")).toHaveLength(0)
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
      if (recovered) {
        try { recovered.release(PROOF) } catch { /* held state remains fail-closed for fixture cleanup */ }
      }
    }
  })
})

const crashChildProgram = `
  import { mock } from "bun:test";
  import * as pathModule from "node:path";

  const realFs = await import("node:fs");
  const originals = {
    openSync: realFs.openSync.bind(realFs), closeSync: realFs.closeSync.bind(realFs),
    writeSync: realFs.writeSync.bind(realFs), readFileSync: realFs.readFileSync.bind(realFs),
    fsyncSync: realFs.fsyncSync.bind(realFs), renameSync: realFs.renameSync.bind(realFs),
    fstatSync: realFs.fstatSync.bind(realFs),
    kill: process.kill.bind(process),
  };
  const descriptorPaths = new Map();
  const expectedTarget = process.env.SESSION_CRASH_TARGET;
  const expectedBoundary = process.env.SESSION_CRASH_BOUNDARY;
  let renamedTarget;
  let clearedTarget;

  const asPath = value => typeof value === "string" ? value : String(value);
  const targetForTemporary = path => {
    const resolved = pathModule.resolve(path);
    const target = pathModule.resolve(expectedTarget);
    return pathModule.dirname(resolved) === pathModule.dirname(target) &&
      pathModule.basename(resolved).startsWith("." + pathModule.basename(target) + ".") &&
      pathModule.basename(resolved).endsWith(".tmp") ? target : undefined;
  };
  const terminateAt = (boundary, targetPath) => {
    const receiptPath = process.env.SESSION_CRASH_RECEIPT;
    const receipt = {
      boundary, actualOwnedPID: process.pid, targetPath,
      sessionID: process.env.SESSION_CRASH_SESSION, stage: expectedBoundary,
    };
    const fd = originals.openSync(receiptPath, realFs.constants.O_WRONLY | realFs.constants.O_CREAT | realFs.constants.O_EXCL, 0o600);
    originals.writeSync(fd, Buffer.from(JSON.stringify(receipt) + "\\n"));
    realFs.fsyncSync(fd);
    originals.closeSync(fd);
    const directory = originals.openSync(pathModule.dirname(receiptPath), realFs.constants.O_RDONLY | (realFs.constants.O_DIRECTORY ?? 0));
    realFs.fsyncSync(directory);
    originals.closeSync(directory);
    originals.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL unexpectedly returned");
  };

  mock.module("node:fs", () => ({
    ...realFs,
    openSync(path, ...args) {
      const text = asPath(path);
      const target = targetForTemporary(text);
      if (target && expectedBoundary === "before-temp-create") terminateAt("before-temp-create", target);
      const fd = originals.openSync(path, ...args);
      descriptorPaths.set(fd, text);
      return fd;
    },
    closeSync(fd) {
      descriptorPaths.delete(fd);
      return originals.closeSync(fd);
    },
    fsyncSync(fd) {
      const path = descriptorPaths.get(fd);
      const result = originals.fsyncSync(fd);
      if (!path) return result;
      const target = targetForTemporary(path);
      if (target && expectedBoundary === "after-file-fsync-before-rename") terminateAt("after-file-fsync-before-rename", target);
      if (target && target === expectedTarget && expectedBoundary === "after-durable-clear-before-token-publication") {
        try {
          const data = JSON.parse(originals.readFileSync(path, "utf8"));
          if (data.held === false) clearedTarget = target;
        } catch {}
      }
      let isDirectory = false;
      try { isDirectory = originals.fstatSync(fd).isDirectory(); } catch {}
      if (isDirectory && renamedTarget === expectedTarget && path === pathModule.dirname(expectedTarget)) {
        if (expectedBoundary === "after-dir-fsync") terminateAt("after-dir-fsync", expectedTarget);
        if (expectedBoundary === "after-durable-clear-before-token-publication" && clearedTarget === expectedTarget) {
          terminateAt("after-durable-clear-before-token-publication", expectedTarget);
        }
      }
      return result;
    },
    renameSync(from, to) {
      const target = pathModule.resolve(asPath(to));
      const result = originals.renameSync(from, to);
      if (target === expectedTarget) {
        renamedTarget = target;
        if (expectedBoundary === "after-rename-before-dir-fsync") terminateAt("after-rename-before-dir-fsync", target);
      }
      return result;
    },
  }));

  (async () => {
    const { fakeClient, makeDeps } = await import(process.env.SESSION_CRASH_HELPERS_URL);
    const { getOpenCodeRuntime } = await import(process.env.SESSION_CRASH_RUNTIME_URL);
    const { attachAdmission } = await import(process.env.SESSION_CRASH_ADMISSION_URL);
    const client = fakeClient({ promptAsync: true });
    client.session.get = async ({ path }) => ({ data: { id: path.id, directory: process.env.SESSION_CRASH_WORKTREE, time: { created: 1, updated: 2 } } });
    const runtime = getOpenCodeRuntime(makeDeps(client, process.env.SESSION_CRASH_WORKTREE));
    attachAdmission(runtime, process.env.SESSION_CRASH_SESSION, { engine: "opencode" });
    process.exitCode = 4;
  })().catch(error => { console.error(error); process.exitCode = 5; });
`

import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { graphSandboxProfile, PYTHON_EXECUTABLE } from "../src/repo-search/runtime.ts"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-search-security-")))
  directories.push(root)
  const input = join(root, "input")
  const output = join(root, "output")
  mkdirSync(input); mkdirSync(output)
  writeFileSync(join(input, "source.py"), "admitted")
  writeFileSync(join(root, "secret"), "not-admitted")
  return { root, input, output }
}
function python(profile: string, source: string) {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, PYTHON_EXECUTABLE, "-I", "-S", "-B", "-c", source], {
    timeout: 10_000,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  })
}

// This suite certifies only the actual platform it runs on; unsupported platforms are not qualified.
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("Graphify real Seatbelt boundary", () => {
  test("build can read admitted snapshot and write output but not read or modify a sibling", () => {
    const { root, input, output } = fixture()
    const result = python(graphSandboxProfile([input], [], output), `import pathlib,json
assert pathlib.Path(${JSON.stringify(join(input, "source.py"))}).read_text()=="admitted"
pathlib.Path(${JSON.stringify(join(output, "graph.json"))}).write_text("graph")
for p,mode in [(${JSON.stringify(join(root, "secret"))},"r"),(${JSON.stringify(join(input, "source.py"))},"w"),(${JSON.stringify(join(root, "secret"))},"w")]:
 try:
  open(p,mode)
 except PermissionError:
  pass
 else:
  raise AssertionError("sandbox permitted forbidden access")
try:
 pathlib.Path(${JSON.stringify(join(root, "secret"))}).stat()
except PermissionError:
 pass
else:
 raise AssertionError("sandbox exposed sibling metadata")
print("blocked")`)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("blocked")
    expect(readFileSync(join(root, "secret"), "utf8")).toBe("not-admitted")
    expect(readFileSync(join(output, "graph.json"), "utf8")).toBe("graph")
  })

  test("query grants one graph, not its directory, and cannot write logs", () => {
    const { input, output } = fixture()
    const graph = join(input, "source.py")
    const result = python(graphSandboxProfile([], [graph]), `import pathlib
assert pathlib.Path(${JSON.stringify(graph)}).read_text()=="admitted"
for p in [${JSON.stringify(graph)},${JSON.stringify(join(output, "query.log"))}]:
 try:
  open(p,"w")
 except PermissionError:
  pass
 else:
  raise AssertionError("query wrote a file")
print("readonly")`)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("readonly")
  })

  test("external and loopback networking and process creation are denied by the kernel", () => {
    const result = python(graphSandboxProfile([], []), `import socket,os,subprocess,sys
for address in [("127.0.0.1",9),("198.51.100.1",443)]:
 s=socket.socket(); s.settimeout(1)
 try:
  s.connect(address)
 except PermissionError:
  pass
 else:
  raise AssertionError("network not denied")
 finally:
  s.close()
try:
 pid=os.fork()
except PermissionError:
 pass
else:
 if pid==0: os._exit(93)
 os.waitpid(pid,0)
 raise AssertionError("fork allowed")
for command in [["/usr/bin/true"],[sys.executable,"-I","-S","-c","pass"]]:
 try:
  subprocess.run(command,check=True)
 except PermissionError:
  pass
 else:
  raise AssertionError("exec allowed")
print("contained")`)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("contained")
  })

  test("an existing host Unix socket remains inaccessible", async () => {
    const { root } = fixture()
    const socketPath = join(root, "host.sock")
    const server = createServer(socket => socket.destroy())
    await new Promise<void>((accept, reject) => {
      server.once("error", reject)
      server.listen(socketPath, accept)
    })
    try {
      const result = python(graphSandboxProfile([], [socketPath]), `import socket
s=socket.socket(socket.AF_UNIX); s.settimeout(1)
try:
 s.connect(${JSON.stringify(socketPath)})
except PermissionError:
 print("blocked")
else:
 raise AssertionError("host socket allowed")
finally:
 s.close()`)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("blocked")
    } finally {
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
    }
  })
})

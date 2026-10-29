import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const modulePath = fileURLToPath(new URL("../src/hosts/interactive-session.ts", import.meta.url))

test("readline keeps busy input FIFO, separates approvals, holds admission and expires session input", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { createReadlineTerminal } from ${JSON.stringify(modulePath)};
    const terminal = createReadlineTerminal();
    const signal = AbortSignal.timeout(8000);
    const chat = { title: "Chat", hint: "", prompt: "You> ", kind: "chat" };
    const waitFor = async predicate => {
      while (!predicate()) { if (signal.aborted) throw new Error("fixture timeout"); await Bun.sleep(5); }
    };
    const controls = [];
    terminal.controls(action => controls.push(action));
    terminal.queueAdmission(true);
    console.log("FIRST");
    assert.equal(await terminal.readInput(chat, signal), "first");
    console.log("BUSY");
    await waitFor(() => terminal.draftSnapshot().queued.length === 2 && controls.length === 3);
    assert.deepEqual(controls, ["pause", "cancel", "quit"]);
    assert.deepEqual(terminal.draftSnapshot().queued, ["next one", "next two"]);
    console.log("APPROVAL");
    assert.equal(await terminal.readLine("Approve> ", signal), "fresh approval");
    assert.equal(terminal.draftSnapshot().queued.length, 2);
    console.log("SELECTION");
    assert.equal(await terminal.readInput({ ...chat, kind: "selection" }, signal), "fresh selection");
    assert.equal(terminal.draftSnapshot().queued.length, 2);
    terminal.queueAdmission(false);
    console.log("HELD");
    assert.equal(await terminal.readInput(chat, signal), "explicit resume");
    assert.equal(terminal.draftSnapshot().queued.length, 2);
    terminal.queueAdmission(true);
    assert.equal(await terminal.readInput(chat, signal), "next one");
    assert.equal(await terminal.readInput(chat, signal), "next two");
    console.log("EXPIRE");
    await waitFor(() => terminal.draftSnapshot().queued.length === 1);
    terminal.sessionChanged();
    assert.deepEqual(terminal.draftSnapshot().queued, []);
    terminal.suspend(); terminal.resume();
    console.log("RESUMED");
    await waitFor(() => terminal.draftSnapshot().queued.length === 1);
    terminal.queueAdmission(true);
    assert.equal(await terminal.readInput(chat, signal), "after external approval");
    terminal.close();
    console.log("PASSED");
    process.exit(0);
  `
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text()
  const answers: Record<string, string> = {
    FIRST: "first\n",
    BUSY: "next one\nnext two\n/pause\n/cancel\n/quit\n",
    APPROVAL: "fresh approval\n",
    SELECTION: "fresh selection\n",
    HELD: "explicit resume\n",
    EXPIRE: "old session\n",
    RESUMED: "after external approval\n",
  }
  const events: string[] = []
  try {
    let pending = ""
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = pending.indexOf("\n")) !== -1) {
        const event = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        events.push(event)
        if (answers[event]) { child.stdin.write(answers[event]!); child.stdin.flush() }
      }
    }
    const code = await child.exited
    const diagnostic = await stderr
    expect(code, diagnostic).toBe(0)
    expect(events).toContain("PASSED")
    expect(diagnostic).toContain("Queued for the next turn (2 waiting).")
    expect(diagnostic).toContain("Queued input expired with the previous session.")
  } finally {
    child.kill()
    await child.exited
  }
}, 12000)

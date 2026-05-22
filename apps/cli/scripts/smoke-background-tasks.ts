import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  createShellExecutor,
  disposeTaskServices,
  getOrCreateTaskServices,
  hasPendingBackgroundUpdates,
  type Task,
} from "@leharness/harness"

const sessionId = `smoke-bg-${Date.now()}`
const services = getOrCreateTaskServices(sessionId)
const executor = createShellExecutor({ queue: services.queue, registry: services.registry })

// 1. Adopt a short-running child and assert task.completed lands.
{
  const child = spawn("/bin/bash", ["-c", "echo hi; sleep 0.05"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const task: Task = {
    id: "task_smoke_completed",
    kind: "shell",
    sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: "echo hi; sleep 0.05" },
  }
  services.registry.register(task, executor)
  executor.adopt(child, task, [])

  const completed = await services.registry.whenTerminal(task.id)
  assert.equal(completed, "completed", `expected completed, got ${completed}`)

  const messages = services.queue.drain()
  const completion = messages.find((m) => m.taskId === task.id)
  assert.ok(completion, "expected a Message for the task")
  assert.equal(completion.kind, "task.completed")
  if (completion.kind === "task.completed") {
    assert.ok(completion.result.includes("hi"), "result should contain command output")
    assert.equal(completion.summary, "exit 0")
  }
}

// 2. Adopt a failing child and assert task.failed lands.
{
  const child = spawn("/bin/bash", ["-c", "exit 3"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const task: Task = {
    id: "task_smoke_failed",
    kind: "shell",
    sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: "exit 3" },
  }
  services.registry.register(task, executor)
  executor.adopt(child, task, [])

  const terminal = await services.registry.whenTerminal(task.id)
  assert.equal(terminal, "failed", `expected failed, got ${terminal}`)

  const messages = services.queue.drain()
  const failure = messages.find((m) => m.taskId === task.id)
  assert.ok(failure, "expected a Message for the failing task")
  assert.equal(failure.kind, "task.failed")
  if (failure.kind === "task.failed") {
    assert.ok(
      failure.summary?.includes("exit 3"),
      `summary should mention exit 3, got ${failure.summary}`,
    )
  }
}

// 3. Adopt a long-running child, cancel, assert task.cancelled lands.
{
  const child = spawn("/bin/bash", ["-c", "sleep 30"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const task: Task = {
    id: "task_smoke_cancelled",
    kind: "shell",
    sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: "sleep 30" },
  }
  services.registry.register(task, executor)
  executor.adopt(child, task, [])

  await executor.cancel(task.id)
  const terminal = await services.registry.whenTerminal(task.id)
  assert.equal(terminal, "cancelled", `expected cancelled, got ${terminal}`)

  const messages = services.queue.drain()
  const cancel = messages.find((m) => m.taskId === task.id)
  assert.ok(cancel, "expected a Message for the cancelled task")
  assert.equal(cancel.kind, "task.cancelled")
  if (cancel.kind === "task.cancelled") {
    assert.equal(cancel.reason, "user")
  }
}

// 4. snapshot exposes accumulated output while running.
{
  const child = spawn("/bin/bash", ["-c", "echo first; sleep 0.5; echo second"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const task: Task = {
    id: "task_smoke_snapshot",
    kind: "shell",
    sessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: "echo first; sleep 0.5; echo second" },
  }
  services.registry.register(task, executor)
  executor.adopt(child, task, [])

  await new Promise((resolve) => setTimeout(resolve, 150))
  const snap = executor.snapshot(task.id)
  assert.ok(snap, "expected a snapshot for the running task")
  assert.ok(
    snap.output.includes("first"),
    `expected snapshot to include first output, got ${snap.output}`,
  )
  assert.equal(snap.state, "running")

  await services.registry.whenTerminal(task.id)
  services.queue.drain()
}

// 5. disposeTaskServices cancels outstanding tasks and clears the session.
{
  const disposeSessionId = `smoke-bg-dispose-${Date.now()}`
  const disposeServices = getOrCreateTaskServices(disposeSessionId)
  const disposeExecutor = createShellExecutor({
    queue: disposeServices.queue,
    registry: disposeServices.registry,
  })
  const child = spawn("/bin/bash", ["-c", "sleep 30"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const task: Task = {
    id: "task_smoke_dispose",
    kind: "shell",
    sessionId: disposeSessionId,
    state: "running",
    startedAt: new Date().toISOString(),
    payload: { kind: "shell", command: "sleep 30" },
  }
  disposeServices.registry.register(task, disposeExecutor)
  disposeExecutor.adopt(child, task, [])

  await disposeTaskServices(disposeSessionId)

  // Calling getOrCreateTaskServices again on the same id returns a fresh
  // services object — the previous one is gone.
  const fresh = getOrCreateTaskServices(disposeSessionId)
  assert.notEqual(fresh, disposeServices, "expected a fresh services after dispose")
  assert.equal(fresh.registry.list(disposeSessionId).length, 0, "fresh registry should be empty")
  assert.equal(hasPendingBackgroundUpdates(disposeSessionId), false)
}

console.log("smoke-background-tasks: shell executor + queue round-trips ok")

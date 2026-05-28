// smoke-prompt-input.ts
// Lock the prompt's text-editing rules (the regression that shipped once:
// a multi-line paste was truncated to its first line and submitted).
// Drives the pure reduceTextKey extracted from the prompt component.

import assert from "node:assert/strict"
import { reduceTextKey, type TextKeyAction } from "../src/components/prompt.js"

function expectUpdate(action: TextKeyAction): { value: string; cursorOffset: number } {
  assert.equal(action.kind, "update")
  if (action.kind !== "update") throw new Error("expected an update action")
  return action
}

// Typing a character inserts it at the cursor.
let u = expectUpdate(reduceTextKey("", 0, "a", {}, true))
assert.equal(u.value, "a")
assert.equal(u.cursorOffset, 1)

// Insert mid-string at the cursor.
u = expectUpdate(reduceTextKey("ac", 1, "b", {}, true))
assert.equal(u.value, "abc")
assert.equal(u.cursorOffset, 2)

// A lone Enter submits.
assert.equal(reduceTextKey("hello", 5, "", { return: true }, true).kind, "submit")
// A bare carriage return (how some terminals deliver Enter) also submits.
assert.equal(reduceTextKey("hello", 5, "\r", { return: true }, true).kind, "submit")

// A multi-line paste is inserted intact — NOT truncated and submitted.
const pasted = '{\n  "url": "https://x"\n}'
u = expectUpdate(reduceTextKey("", 0, pasted, {}, true))
assert.equal(u.value, pasted, "multi-line paste must survive intact")
assert.equal(u.cursorOffset, pasted.length)

// CRLF / CR paste line endings normalize to \n.
assert.equal(expectUpdate(reduceTextKey("", 0, "a\r\nb", {}, true)).value, "a\nb")
assert.equal(expectUpdate(reduceTextKey("", 0, "a\rb", {}, true)).value, "a\nb")

// Shift+Enter composes a newline at the cursor instead of submitting.
u = expectUpdate(reduceTextKey("ab", 1, "\r", { return: true, shift: true }, true))
assert.equal(u.value, "a\nb")
assert.equal(u.cursorOffset, 2)

// Backspace deletes the character before the cursor.
u = expectUpdate(reduceTextKey("abc", 2, "", { backspace: true }, true))
assert.equal(u.value, "ac")
assert.equal(u.cursorOffset, 1)

// Backspace at the start is a no-op.
u = expectUpdate(reduceTextKey("abc", 0, "", { backspace: true }, true))
assert.equal(u.value, "abc")
assert.equal(u.cursorOffset, 0)

// Arrow keys move the cursor without changing the buffer.
u = expectUpdate(reduceTextKey("abc", 2, "", { leftArrow: true }, true))
assert.equal(u.value, "abc")
assert.equal(u.cursorOffset, 1)

console.log("smoke-prompt-input: typing / enter / multi-line paste / shift+enter / backspace ok")

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePhaseSession } from "../src/exec/session.ts";

test("resolvePhaseSession: explicit id is honored with defaults", () => {
	const resolved = resolvePhaseSession(
		{ id: "work", type: "agent", agent: "a", task: "x", session: { id: "worker-8en" } },
		"run-1",
	);
	assert.deepEqual(resolved, { id: "worker-8en", dir: undefined, mode: "continue" });
});

test("resolvePhaseSession: key is scoped to the current run", () => {
	const a = resolvePhaseSession(
		{ id: "work", type: "agent", agent: "a", task: "x", session: { key: "worker" } },
		"run-1",
	);
	const b = resolvePhaseSession(
		{ id: "fix", type: "agent", agent: "a", task: "x", session: { key: "worker" } },
		"run-1",
	);
	const otherRun = resolvePhaseSession(
		{ id: "work", type: "agent", agent: "a", task: "x", session: { key: "worker" } },
		"run-2",
	);
	assert.equal(a?.id, "run-1-worker");
	assert.equal(b?.id, a?.id, "work and fix share one session inside the run");
	assert.equal(otherRun?.id, "run-2-worker", "a new run does not inherit the old session");
});

test("resolvePhaseSession: fresh mode synthesizes a unique id", () => {
	const spec = { key: "worker", mode: "fresh" as const };
	const a = resolvePhaseSession({ id: "work", type: "agent", agent: "a", task: "x", session: spec }, "run-1");
	const b = resolvePhaseSession({ id: "work", type: "agent", agent: "a", task: "x", session: spec }, "run-1");
	assert.notEqual(a?.id, b?.id);
	assert.match(a?.id ?? "", /^run-1-worker-f/);
});

test("resolvePhaseSession: absent session opt-in stays off", () => {
	assert.equal(resolvePhaseSession({ id: "work", type: "agent", agent: "a", task: "x" }, "run-1"), undefined);
});

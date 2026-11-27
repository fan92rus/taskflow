import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePhaseSession } from "../src/exec/session.ts";

test("resolvePhaseSession: explicit id is honored with defaults", () => {
	const resolved = resolvePhaseSession(
		{ id: "work", type: "agent", agent: "a", task: "x", session: { id: "worker-8en" } },
		"run-1",
	);
	assert.deepEqual(resolved, { id: "worker-8en", dir: undefined, mode: "continue", cleanup: "run" });
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

test("resolvePhaseSession: interpolates explicit id and dir from args/steps", () => {
	const phase = {
		id: "fix",
		type: "agent" as const,
		agent: "a",
		task: "x",
		session: { id: "{args.sessionId}", dir: "{steps.session-dir.output}" },
	};
	const resolved = resolvePhaseSession(phase, "run-2", {
		args: { sessionId: "run-1-worker" },
		steps: { "session-dir": { output: "D:/tmp/sessions" } },
	});
	assert.deepEqual(resolved, { id: "run-1-worker", dir: "D:/tmp/sessions", mode: "continue", cleanup: "run" });
});

test("resolvePhaseSession: disables reuse when a placeholder stays unresolved", () => {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message?: unknown) => warnings.push(String(message));
	try {
		const resolved = resolvePhaseSession(
			{ id: "fix", type: "agent", agent: "a", task: "x", session: { id: "{args.missing}" } },
			"run-3",
			{ args: {}, steps: {} },
		);
		assert.equal(resolved, undefined);
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = original;
	}
});

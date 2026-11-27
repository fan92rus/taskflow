import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { RunResult } from "../src/runner-core.ts";
import { validateTaskflow, type Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow, args: Record<string, unknown> = {}, runId = "repeat-run"): RunState {
	return {
		runId,
		flowName: def.name,
		def,
		args,
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

function baseDeps(runTask: RuntimeDeps["runTask"], extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
	return { cwd: process.cwd(), agents: AGENTS, runTask, persist: () => {}, onProgress: () => {}, ...extra };
}

const sprintFlow: Taskflow = {
	name: "sprint",
	args: { cursor: { type: "string", default: "0" } },
	phases: [{ id: "s", type: "agent", agent: "a", task: "sprint {args.cursor}", output: "json", final: true }],
};

function countingRunner(seen: string[]): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agent, task): Promise<RunResult> => {
		seen.push(task);
		const n = Number(task.replace("sprint ", ""));
		return {
			agent,
			task,
			exitCode: 0,
			output: JSON.stringify({ done: n >= 2, cursor: String(n + 1) }),
			stderr: "",
			usage: { ...emptyUsage(), input: 1, output: 2, turns: 1 },
			stopReason: "end",
		};
	};
}

test("flow.repeat: schema accepts a bounded repeat with carry", () => {
	const v = validateTaskflow({
		name: "loop-flow",
		phases: [
			{
				id: "sprint",
				type: "flow",
				use: "sprint",
				output: "json",
				final: true,
				repeat: { until: "{steps.sprint.json.done} == true", max: 5, carry: ["cursor"] },
			},
		],
	});
	assert.deepEqual(v.errors, []);
});

test("flow.repeat: rejects repeating the current flow", () => {
	const v = validateTaskflow({
		name: "self-driver",
		phases: [
			{
				id: "sprint",
				type: "flow",
				use: "self-driver",
				output: "json",
				final: true,
				repeat: { until: "true", max: 2 },
			},
		],
	});
	assert.ok(v.errors.some((e) => e.includes("cannot repeat the current flow")));
});

test("flow.repeat: rejects max outside the hard cap", () => {
	const v = validateTaskflow({
		name: "bad",
		phases: [
			{
				id: "sprint",
				type: "flow",
				use: "sprint",
				output: "json",
				final: true,
				repeat: { until: "false", max: 999 },
			},
		],
	});
	assert.ok(v.errors.some((e) => e.includes("max must be <= 20")));
});

test("flow.repeat: a malformed until guard fails loudly", async () => {
	const seen: string[] = [];
	const def: Taskflow = {
		name: "bad-guard",
		phases: [
			{
				id: "sprint",
				type: "flow",
				use: "sprint",
				output: "json",
				final: true,
				repeat: { until: "{", max: 2 },
			},
		],
	};
	const res = await executeTaskflow(
		mkState(def),
		baseDeps(countingRunner(seen), { loadFlow: (n) => (n === "sprint" ? sprintFlow : undefined) }),
	);
	assert.equal(res.ok, false);
	assert.equal(seen.length, 1);
	assert.match(res.state.phases.sprint.error ?? "", /guard error/);
});

for (const eventKernel of [false, true]) {
	test(`flow.repeat: carries args across sub-flow runs (eventKernel=${eventKernel})`, async () => {
		const seen: string[] = [];
		const def: Taskflow = {
			name: "campaign-driver",
			args: { cursor: { default: "0" } },
			phases: [
				{
					id: "sprint",
					type: "flow",
					use: "sprint",
					with: { cursor: "{args.cursor}" },
					output: "json",
					final: true,
					repeat: { until: "{steps.sprint.json.done} == true", max: 5, carry: ["cursor"] },
				},
			],
		};
		const res = await executeTaskflow(
			mkState(def, { cursor: "0" }, eventKernel ? "k" : "i"),
			baseDeps(countingRunner(seen), { eventKernel, loadFlow: (n) => (n === "sprint" ? sprintFlow : undefined) }),
		);
		assert.equal(res.ok, true, res.finalOutput);
		assert.deepEqual(seen, ["sprint 0", "sprint 1", "sprint 2"]);
		assert.equal(res.state.phases.sprint.status, "done");
		assert.deepEqual(res.state.phases.sprint.repeat, { iterations: 3, stop: "until" });
		assert.equal((res.state.phases.sprint.json as { done: boolean }).done, true);
	});

	test(`flow.repeat: missing carry field warns and keeps previous arg (eventKernel=${eventKernel})`, async () => {
		const seen: string[] = [];
		const runner: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
			seen.push(task);
			return {
				agent,
				task,
				exitCode: 0,
				output: JSON.stringify({ done: false }),
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 2, turns: 1 },
				stopReason: "end",
			};
		};
		const def: Taskflow = {
			name: "missing-carry",
			args: { cursor: { default: "0" } },
			phases: [
				{
					id: "sprint",
					type: "flow",
					use: "sprint",
					with: { cursor: "{args.cursor}" },
					output: "json",
					final: true,
					repeat: { until: "{steps.sprint.json.done} == true", max: 2, carry: ["cursor"] },
				},
			],
		};
		const res = await executeTaskflow(
			mkState(def, { cursor: "0" }, eventKernel ? "k-carry" : "i-carry"),
			baseDeps(runner, { eventKernel, loadFlow: (n) => (n === "sprint" ? sprintFlow : undefined) }),
		);
		assert.equal(res.ok, false);
		assert.deepEqual(seen, ["sprint 0", "sprint 0"]);
		assert.ok((res.state.phases.sprint.warnings ?? []).some((w) => w.includes("carry 'cursor' missing")));
	});

	test(`flow.repeat: exhausting max fails loudly (eventKernel=${eventKernel})`, async () => {
		const seen: string[] = [];
		const runner: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
			seen.push(task);
			return {
				agent,
				task,
				exitCode: 0,
				output: JSON.stringify({ done: false, cursor: "1" }),
				stderr: "",
				usage: { ...emptyUsage(), input: 1, output: 2, turns: 1 },
				stopReason: "end",
			};
		};
		const def: Taskflow = {
			name: "never-done",
			phases: [
				{
					id: "sprint",
					type: "flow",
					use: "sprint",
					output: "json",
					final: true,
					repeat: { until: "{steps.sprint.json.done} == true", max: 2 },
				},
			],
		};
		const res = await executeTaskflow(
			mkState(def, {}, eventKernel ? "k-max" : "i-max"),
			baseDeps(runner, { eventKernel, loadFlow: (n) => (n === "sprint" ? sprintFlow : undefined) }),
		);
		assert.equal(res.ok, false);
		assert.equal(seen.length, 2);
		assert.match(res.state.phases.sprint.error ?? "", /did not satisfy 'until' after 2 iterations/);
	});
}

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupRunSessions,
	defaultSessionDir,
	resetTrackedSessions,
	trackRunSession,
} from "../src/session-cleanup.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSession(dir: string, id: string, name: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`);
	return file;
}

test("cleanupRunSessions removes only sessions tracked for the run", () => {
	resetTrackedSessions();
	const root = tmpDir("tf-cleanup-");
	try {
		const cwd = path.join(root, "repo");
		const sessions = path.join(root, "sessions");
		fs.mkdirSync(cwd);
		fs.mkdirSync(sessions);
		const owned = writeSession(sessions, "run-1-worker", "a_owned.jsonl");
		const foreign = writeSession(sessions, "other-session", "b_foreign.jsonl");

		trackRunSession("run-1", { id: "run-1-worker", dir: sessions }, cwd);
		const report = cleanupRunSessions("run-1", {});

		assert.deepEqual(report.deleted, [owned]);
		assert.deepEqual(report.errors, []);
		assert.equal(fs.existsSync(owned), false);
		assert.equal(fs.existsSync(foreign), true, "untracked sessions are untouched");
		assert.deepEqual(cleanupRunSessions("run-1", {}), { deleted: [], missing: [], errors: [], skippedDebug: [] });
	} finally {
		resetTrackedSessions();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cleanupRunSessions respects the debug retention flag", () => {
	resetTrackedSessions();
	const root = tmpDir("tf-cleanup-debug-");
	try {
		const cwd = path.join(root, "repo");
		const sessions = path.join(root, "sessions");
		fs.mkdirSync(cwd);
		fs.mkdirSync(sessions);
		const file = writeSession(sessions, "run-2-worker", "a_worker.jsonl");

		trackRunSession("run-2", { id: "run-2-worker", dir: sessions }, cwd);
		const kept = cleanupRunSessions("run-2", { TASKFLOW_DEBUG: "1" });
		assert.deepEqual(kept.skippedDebug, ["run-2-worker"]);
		assert.equal(fs.existsSync(file), true, "debug keeps the transcript");

		const removed = cleanupRunSessions("run-2", { TASKFLOW_KEEP_SESSIONS: "false" });
		assert.deepEqual(removed.deleted, [file]);
		assert.equal(fs.existsSync(file), false);
	} finally {
		resetTrackedSessions();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cleanupRunSessions mirrors Pi's default cwd-grouped session directory", () => {
	resetTrackedSessions();
	const root = tmpDir("tf-cleanup-default-");
	try {
		const cwd = path.join(root, "repo");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const dir = defaultSessionDir(cwd, { PI_CODING_AGENT_DIR: agentDir });
		fs.mkdirSync(dir, { recursive: true });
		const file = writeSession(dir, "run-3-worker", "a_worker.jsonl");

		trackRunSession("run-3", { id: "run-3-worker" }, cwd);
		const report = cleanupRunSessions("run-3", { PI_CODING_AGENT_DIR: agentDir });
		assert.deepEqual(report.deleted, [file]);
		assert.equal(fs.existsSync(file), false);
	} finally {
		resetTrackedSessions();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cleanupRunSessions reports a missing transcript without throwing", () => {
	resetTrackedSessions();
	const root = tmpDir("tf-cleanup-missing-");
	try {
		trackRunSession("run-4", { id: "run-4-worker", dir: root }, root);
		const report = cleanupRunSessions("run-4", {});
		assert.deepEqual(report.missing, ["run-4-worker"]);
		assert.deepEqual(report.deleted, []);
		assert.deepEqual(report.errors, []);
	} finally {
		resetTrackedSessions();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Cleanup for Pi sessions opened by Taskflow `session` phases.
 *
 * Taskflow owns these transcripts for the lifetime of a run: the runner opens
 * them with `--session-id` so work → fix can continue the same agent. Once the
 * run reaches a terminal state the artifacts are no longer needed, so they are
 * deleted by default. Set `TASKFLOW_DEBUG=1` (or `TASKFLOW_KEEP_SESSIONS=1`)
 * to keep them for post-mortem inspection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface TrackedSession {
	id: string;
	dir?: string;
	cwd: string;
}

const sessionsByRun = new Map<string, Map<string, TrackedSession>>();

function truthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** True when the operator asked Taskflow to retain session artifacts. */
export function keepSessionArtifacts(env: NodeJS.ProcessEnv = process.env): boolean {
	return truthyEnv(env.TASKFLOW_DEBUG) || truthyEnv(env.TASKFLOW_KEEP_SESSIONS);
}

/** Remember a session opened by a phase so it can be removed when the run ends. */
export function trackRunSession(
	runId: string | undefined,
	session: { id: string; dir?: string },
	cwd: string,
): void {
	if (!runId || !session.id) return;
	let owned = sessionsByRun.get(runId);
	if (!owned) {
		owned = new Map();
		sessionsByRun.set(runId, owned);
	}
	owned.set(session.id, { id: session.id, dir: session.dir, cwd });
}

function expandTilde(value: string): string {
	if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function agentDir(env: NodeJS.ProcessEnv): string {
	return path.resolve(expandTilde(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")));
}

/** Mirror Pi's default session directory encoding for a phase cwd. */
export function defaultSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const resolved = path.resolve(cwd);
	const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(agentDir(env), "sessions", safe);
}

function configuredSessionDir(entry: TrackedSession, env: NodeJS.ProcessEnv): string {
	if (entry.dir) return path.resolve(entry.cwd, expandTilde(entry.dir));
	if (env.PI_CODING_AGENT_SESSION_DIR) {
		return path.resolve(entry.cwd, expandTilde(env.PI_CODING_AGENT_SESSION_DIR));
	}
	try {
		const settingsPath = path.join(agentDir(env), "settings.json");
		if (fs.existsSync(settingsPath)) {
			const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { sessionDir?: unknown };
			if (typeof raw.sessionDir === "string" && raw.sessionDir.trim()) {
				return path.resolve(entry.cwd, expandTilde(raw.sessionDir.trim()));
			}
		}
	} catch {
		// Pi settings are optional; fall back to the documented default.
	}
	return defaultSessionDir(entry.cwd, env);
}

function headerId(file: string): string | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(4096);
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0]?.trim();
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		if (header.type !== "session" || typeof header.id !== "string") return undefined;
		return header.id;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

function findSessionFile(dir: string, id: string): string | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const candidate = path.join(dir, entry);
		if (headerId(candidate) === id) return candidate;
	}
	return undefined;
}

export interface SessionCleanupReport {
	deleted: string[];
	missing: string[];
	errors: string[];
	skippedDebug: string[];
}

/**
 * Delete every session artifact tracked for `runId`. Failures are reported,
 * never thrown: cleanup must never turn a completed run into a failed one.
 */
export function cleanupRunSessions(
	runId: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): SessionCleanupReport {
	const report: SessionCleanupReport = { deleted: [], missing: [], errors: [], skippedDebug: [] };
	if (!runId) return report;
	const owned = sessionsByRun.get(runId);
	if (!owned || owned.size === 0) return report;
	if (keepSessionArtifacts(env)) {
		report.skippedDebug = [...owned.keys()];
		return report;
	}
	for (const entry of owned.values()) {
		try {
			const file = findSessionFile(configuredSessionDir(entry, env), entry.id);
			if (!file) {
				report.missing.push(entry.id);
				continue;
			}
			fs.unlinkSync(file);
			report.deleted.push(file);
		} catch (error) {
			report.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	sessionsByRun.delete(runId);
	return report;
}

/** Test-only helper: drop tracked sessions without touching the filesystem. */
export function resetTrackedSessions(): void {
	sessionsByRun.clear();
}

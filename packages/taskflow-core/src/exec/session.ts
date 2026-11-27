import { randomBytes } from "node:crypto";
import type { Phase } from "../schema.ts";
import type { RunOptions } from "../host/runner-types.ts";

type PhaseSession = Phase["session"];
type SessionOptions = NonNullable<RunOptions["session"]>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;

/**
 * Resolve a flow phase's session opt-in into host-level RunOptions.
 *
 * `key` is scoped to the current run so that a resume continues the same
 * worker session but a NEW run never inherits a stale transcript by accident.
 * An explicit `id` is honored verbatim for callers that deliberately want
 * cross-run continuity.
 */
export function resolvePhaseSession(phase: Phase, runId: string): SessionOptions | undefined {
	const spec: PhaseSession | undefined = phase.session;
	if (!spec) return undefined;

	const explicitId = "id" in spec ? spec.id : undefined;
	const key = "key" in spec ? spec.key : undefined;
	const base = explicitId ?? (key ? `${runId}-${key}` : undefined);
	if (!base) return undefined;

	const mode = spec.mode ?? "continue";
	const id = mode === "fresh"
		? `${base}-f${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`
		: base;
	if (!SAFE_ID.test(id)) return undefined;

	return { id, dir: spec.dir, mode };
}

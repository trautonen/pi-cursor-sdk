import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorSdkEventDebugSink } from "../src/cursor-sdk-event-debug.js";
import { ARTIFACTS, CURSOR_SDK_EVENT_DEBUG_ENV } from "../src/cursor-sdk-event-debug-constants.js";

describe("cursor sdk event debug error capture", () => {
	it("scrubs authorization material out of recorded raw errors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cursor-debug-scrub-"));
		try {
			const sink = CursorSdkEventDebugSink.maybeCreate({
				cwd,
				modelId: "composer-2.5",
				provider: "cursor",
				env: { [CURSOR_SDK_EVENT_DEBUG_ENV]: "1" },
			});
			expect(sink).toBeDefined();

			const error = Object.assign(new Error("send failed with authorization: key_abcdef123456"), {
				config: { headers: { authorization: "Bearer key_abcdef123456" } },
			});
			sink?.recordError("agent_send", error);
			await sink?.finalize();

			const errors = readFileSync(join(sink!.artifactDir, ARTIFACTS.errors), "utf-8");
			expect(errors).not.toContain("key_abcdef123456");
			expect(errors).toContain("[redacted]");
			expect(errors).toContain("agent_send");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

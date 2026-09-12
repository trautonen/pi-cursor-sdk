import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "@cursor/sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	asMockSdkAgent,
	collectEvents,
	getErrorEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	cursorLiveRuns,
	drainExistingCursorLiveRunBeforeSend,
	isForeignConcurrentCursorTurn,
} from "../src/cursor-provider-live-run-drain.js";
import { CONCURRENT_PI_TOOL_CURSOR_TURN_MESSAGE } from "../src/cursor-provider-errors.js";
import { __testUtils as cursorSessionTurnQueueTestUtils } from "../src/cursor-session-turn-queue.js";
import type { CursorPiToolBridgeRun } from "../src/cursor-pi-tool-bridge.js";

function makeBridgeRunAwaitingPiToolResult(pendingPiToolCallIds: string[]): CursorPiToolBridgeRun {
	const pending = new Set(pendingPiToolCallIds);
	return {
		id: "bridge-run-1",
		enabled: true,
		hasPendingPiToolCallId: (piToolCallId: string) => pending.has(piToolCallId),
		hasPendingPiToolCalls: () => pending.size > 0,
		resolveToolResults: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	} as unknown as CursorPiToolBridgeRun;
}

function startLiveRunAwaitingPiToolResult(pendingPiToolCallIds = ["pi-tool-call-1"]) {
	return cursorLiveRuns.start({
		id: "cursor-replay-1-1",
		agent: asMockSdkAgent({ agentId: "agent-1", send: vi.fn() }) as SDKAgent,
		bridgeRun: makeBridgeRunAwaitingPiToolResult(pendingPiToolCallIds),
		promptInputTokens: 10,
	});
}

async function withTimeout<T>(work: Promise<T>, ms = 1000): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("nested Cursor turn started from inside a pi bridge tool", () => {
	beforeEach(resetCursorProviderTestState);

	it("classifies a turn that carries none of the run's tool results as foreign", () => {
		const liveRun = startLiveRunAwaitingPiToolResult();
		try {
			expect(cursorLiveRuns.isAwaitingPiToolResults(liveRun)).toBe(true);
			expect(cursorLiveRuns.isReady(liveRun)).toBe(false);
			expect(
				isForeignConcurrentCursorTurn(
					liveRun,
					makeContext([{ role: "user", content: "Summarize these search results", timestamp: 1 }]),
				),
			).toBe(true);
		} finally {
			void cursorLiveRuns.release(liveRun);
		}
	});

	it("treats the turn that delivers the run's tool result as its continuation", () => {
		const liveRun = startLiveRunAwaitingPiToolResult();
		try {
			expect(
				isForeignConcurrentCursorTurn(
					liveRun,
					makeContext([
						{ role: "user", content: "search the web", timestamp: 1 },
						{
							role: "toolResult",
							toolCallId: "pi-tool-call-1",
							toolName: "web_search",
							content: [{ type: "text", text: "results" }],
							isError: false,
							timestamp: 2,
						},
					]),
				),
			).toBe(false);
		} finally {
			void cursorLiveRuns.release(liveRun);
		}
	});

	it("fails the foreign turn instead of waiting for a run only that turn can unblock", async () => {
		const liveRun = startLiveRunAwaitingPiToolResult();
		try {
			const drain = drainExistingCursorLiveRunBeforeSend(
				createAssistantMessageEventStream(),
				makeAssistantMessage(""),
				makeModel("composer-2.5"),
				makeContext([{ role: "user", content: "Summarize these search results", timestamp: 1 }]),
				undefined,
			);
			await expect(withTimeout(drain)).rejects.toThrow(CONCURRENT_PI_TOOL_CURSOR_TURN_MESSAGE);
			expect(liveRun.disposed).toBe(false);
		} finally {
			await cursorLiveRuns.release(liveRun);
		}
	});

	it("reports the failure through the provider stream and frees the session turn queue", async () => {
		const liveRun = startLiveRunAwaitingPiToolResult();
		try {
			const events = await withTimeout(
				collectEvents(
					streamCursor(
						makeModel("composer-2.5"),
						makeContext([{ role: "user", content: "Summarize these search results", timestamp: 1 }]),
						{ apiKey: "test-key" },
					),
				),
			);
			expect(events).not.toBe("timeout");
			expect(getErrorEvent(events as never).error.errorMessage).toContain(
				"waiting for a pi tool result",
			);
			expect(liveRun.disposed).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(cursorSessionTurnQueueTestUtils.count()).toBe(0);
		} finally {
			await cursorLiveRuns.release(liveRun);
		}
	});
});

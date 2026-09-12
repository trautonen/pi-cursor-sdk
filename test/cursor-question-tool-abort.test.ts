import { describe, expect, it, vi } from "vitest";
import {
	createExtensionTestContext,
	createPiHarness,
	getHarnessRegisteredTool,
} from "./helpers/pi-harness.js";
import { CURSOR_ASK_QUESTION_TOOL_NAME, registerCursorQuestionTool } from "../src/cursor-question-tool.js";

function registerQuestionTool() {
	const pi = createPiHarness();
	registerCursorQuestionTool(pi);
	return getHarnessRegisteredTool(pi._tools, CURSOR_ASK_QUESTION_TOOL_NAME);
}

describe("cursor_ask_question abort handling", () => {
	it("forwards the tool abort signal to the pi dialog so an unattended prompt can be dismissed", async () => {
		const tool = registerQuestionTool();
		const controller = new AbortController();
		const select = vi.fn(async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
			void opts;
			return undefined;
		});
		const ctx = createExtensionTestContext({ ui: { select } });

		await tool.execute(
			"call-1",
			{
				questions: [
					{ question: "Which runtime?", options: [{ label: "local" }, { label: "cloud" }] },
				],
			},
			controller.signal,
			() => {},
			ctx,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0][2]?.signal).toBe(controller.signal);
	});

	it("stops asking further questions once the turn is aborted", async () => {
		const tool = registerQuestionTool();
		const controller = new AbortController();
		controller.abort();
		const input = vi.fn(async () => undefined);
		const ctx = createExtensionTestContext({ ui: { input } });

		const result = await tool.execute(
			"call-2",
			{ questions: [{ question: "First?" }, { question: "Second?" }] },
			controller.signal,
			() => {},
			ctx,
		);

		expect(input).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ uiAvailable: true });
	});
});

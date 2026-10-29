import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type AdvisorAgent,
	AdvisorRuntime,
	type AdvisorRuntimeHost,
	isRateLimitFailure,
	rateLimitRetryDelayMs,
} from "../../src/advisor/runtime";

const ROUTER_429 =
	"429 litellm.proxy.proxy_server: Rate limit exceeded for REDACTED Limit type: max_parallel_requests. Current limit: 1, Remaining: 0.";

describe("advisor rate-limit backoff", () => {
	it("tells a busy-provider answer from a broken advisor", () => {
		expect(isRateLimitFailure(new Error(ROUTER_429))).toBe(true);
		expect(isRateLimitFailure(new Error("429 Too Many Requests"))).toBe(true);
		expect(isRateLimitFailure(new Error("provider failed 1"))).toBe(false);
		expect(isRateLimitFailure(new Error("500 internal server error"))).toBe(
			false,
		);
		expect(isRateLimitFailure(new Error("529 overloaded"))).toBe(false);
	});

	it("doubles the delay per answer in a row, jitters it by plus or minus half, caps it, and keeps zero as zero", () => {
		const mid = () => 0.5; // jitter factor 1.0
		expect(
			[1, 2, 3, 4].map((n) => rateLimitRetryDelayMs(1000, n, mid)),
		).toEqual([1000, 2000, 4000, 8000]);
		expect(rateLimitRetryDelayMs(1000, 30, mid)).toBe(60_000);
		expect(rateLimitRetryDelayMs(1000, 3, () => 0)).toBe(2000);
		expect(rateLimitRetryDelayMs(1000, 3, () => 0.999)).toBeGreaterThan(5900);
		expect(rateLimitRetryDelayMs(1000, 3, () => 0.999)).toBeLessThanOrEqual(
			6000,
		);
		expect(rateLimitRetryDelayMs(0, 5, mid)).toBe(0);
	});

	it("keeps the batch through six rate-limit answers without a strike-out or a failure notice, then delivers it", async () => {
		let prompts = 0;
		const failures: unknown[] = [];
		const state: { messages: AgentMessage[]; error?: string } = {
			messages: [],
		};
		const agent: AdvisorAgent = {
			prompt: async () => {
				prompts++;
				state.error = prompts <= 6 ? ROUTER_429 : undefined;
			},
			abort: () => {},
			reset: () => {
				state.error = undefined;
			},
			state,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "one update", timestamp: 1 } as AgentMessage,
		];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			onTurnError: async () => false,
			notifyFailure: (error) => failures.push(error),
		};
		const runtime = new AdvisorRuntime(agent, host, 1);

		runtime.onTurnEnd(messages);
		const deadline = Date.now() + 5000;
		while (prompts < 7 || runtime.backlog > 0) {
			if (Date.now() > deadline)
				throw new Error(
					`did not settle: prompts=${prompts} backlog=${runtime.backlog}`,
				);
			await Bun.sleep(5);
		}
		expect(prompts).toBe(7);
		expect(failures).toHaveLength(0);
		expect(runtime.backlog).toBe(0);
	});

	it("drops the batch after eight rate-limit answers in a row, so a stuck limit cannot hold it forever", async () => {
		let prompts = 0;
		const notified = Promise.withResolvers<void>();
		const state: { messages: AgentMessage[]; error?: string } = {
			messages: [],
		};
		const agent: AdvisorAgent = {
			prompt: async () => {
				prompts++;
				state.error = ROUTER_429;
			},
			abort: () => {},
			reset: () => {
				state.error = undefined;
			},
			state,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "one update", timestamp: 1 } as AgentMessage,
		];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			onTurnError: async () => false,
			notifyFailure: () => notified.resolve(),
		};
		const runtime = new AdvisorRuntime(agent, host, 0);
		runtime.onTurnEnd(messages);
		await notified.promise;
		expect(prompts).toBe(8);
	});

	it("still strikes out after three real failures", async () => {
		let prompts = 0;
		const notified = Promise.withResolvers<void>();
		const state: { messages: AgentMessage[]; error?: string } = {
			messages: [],
		};
		const agent: AdvisorAgent = {
			prompt: async () => {
				prompts++;
				state.error = `provider failed ${prompts}`;
			},
			abort: () => {},
			reset: () => {
				state.error = undefined;
			},
			state,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "one update", timestamp: 1 } as AgentMessage,
		];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			onTurnError: async () => false,
			notifyFailure: () => notified.resolve(),
		};
		const runtime = new AdvisorRuntime(agent, host, 1);
		runtime.onTurnEnd(messages);
		await notified.promise;
		expect(prompts).toBe(3);
	});
});

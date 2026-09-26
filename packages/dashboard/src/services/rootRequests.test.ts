import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { beforeEach, describe, expect, it } from "vitest";
import api, { apiClient } from "./api";

/**
 * What root's requests carry on the wire. The screen's own test replaces
 * this module, so a body that lost a field would pass it.
 */

const sent: InternalAxiosRequestConfig[] = [];
const answer: AxiosAdapter = async (config) => {
	sent.push(config);
	return { data: {}, status: 200, statusText: "", headers: {}, config };
};

beforeEach(() => {
	sent.length = 0;
	apiClient.defaults.adapter = answer;
});

const bodyOf = (config: InternalAxiosRequestConfig) =>
	JSON.parse(String(config.data));

describe("root's requests", () => {
	it("send root's own password with a password set for somebody", async () => {
		await api.setAccountPassword("u/1", "brand-new-password", "roots-own");

		expect(sent[0].method).toBe("post");
		expect(sent[0].url).toBe("/api/v1/root/accounts/u%2F1/password");
		expect(bodyOf(sent[0])).toEqual({
			password: "brand-new-password",
			currentPassword: "roots-own",
		});
	});

	it("put the reset sender, and an empty one to clear it", async () => {
		await api.setRecoverySender("noreply@example.com");
		await api.setRecoverySender("");

		expect(sent.map((c) => [c.method, c.url])).toEqual([
			["put", "/api/v1/root/settings/account-recovery"],
			["put", "/api/v1/root/settings/account-recovery"],
		]);
		expect(bodyOf(sent[0])).toEqual({ fromEmail: "noreply@example.com" });
		expect(bodyOf(sent[1])).toEqual({ fromEmail: "" });
	});
});

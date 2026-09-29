import { describe, expect, it } from "vitest";
import { splitAddresses, uniqueAddresses } from "./addresses";

describe("an address field split into addresses", () => {
	it("splits at commas and drops the empty ones", () => {
		expect(splitAddresses(" a@example.com, b@example.com ,, ")).toEqual([
			"a@example.com",
			"b@example.com",
		]);
	});

	/**
	 * The Worker stores `"a,b"@example.com` with its quotes, so a reply-all
	 * offers it whole. Split at every comma, it became `"a` and
	 * `b"@example.com`.
	 */
	it("keeps a comma inside quotes in its address", () => {
		expect(splitAddresses('"a,b"@example.com, c@example.com')).toEqual([
			'"a,b"@example.com',
			"c@example.com",
		]);
		expect(splitAddresses('"q\\",x"@example.com, d@example.com')).toEqual([
			'"q\\",x"@example.com',
			"d@example.com",
		]);
	});

	it("keeps a pasted display name with a comma in one piece", () => {
		expect(
			splitAddresses('"Doe, John" <john@example.com>, e@example.com'),
		).toEqual(['"Doe, John" <john@example.com>', "e@example.com"]);
	});
});

describe("addresses made unique", () => {
	it("compares without case and keeps the first spelling", () => {
		expect(uniqueAddresses(["A@x.org", "b@x.org", "a@x.org"])).toEqual([
			"A@x.org",
			"b@x.org",
		]);
	});

	it("leaves out what is already elsewhere", () => {
		expect(uniqueAddresses(["C@x.org", "d@x.org"], ["c@x.org"])).toEqual([
			"d@x.org",
		]);
	});
});

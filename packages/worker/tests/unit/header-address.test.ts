import { describe, expect, it } from "vitest";
import { asHeaderAddress, formatAddressList } from "../../src/recipients";

describe("an address as a header writes it", () => {
	it("leaves a plain address alone", () => {
		for (const address of [
			"plain@example.com",
			"first.last+tag@example.com",
			"o'brien@example.com",
			"用户@例子.广告",
			"",
			"no-at-sign",
		]) {
			expect(asHeaderAddress(address)).toBe(address);
		}
	});

	it("puts back the quotes postal-mime took off", () => {
		expect(asHeaderAddress("a,b@example.com")).toBe('"a,b"@example.com');
		expect(asHeaderAddress("c d@example.com")).toBe('"c d"@example.com');
		expect(asHeaderAddress("x..y@example.com")).toBe('"x..y"@example.com');
		expect(asHeaderAddress('q"t\\s@example.com')).toBe(
			'"q\\"t\\\\s"@example.com',
		);
	});

	it("does not quote twice", () => {
		expect(asHeaderAddress('"a,b"@example.com')).toBe('"a,b"@example.com');
	});

	it("keeps a quoted address one entry of the stored list", () => {
		const stored = formatAddressList(
			["a,b@example.com", "plain@example.com"].map(asHeaderAddress),
		);
		expect(stored).toBe('"a,b"@example.com, plain@example.com');
	});
});

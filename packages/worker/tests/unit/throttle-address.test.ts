import { describe, expect, it } from "vitest";
import { clientIp, throttleAddress } from "../../src/throttle";

/**
 * The per-IP login and reset limits are only a limit if a client cannot
 * step to a new counter at will. An IPv6 subscriber holds a whole /64.
 */
describe("the address a throttle counts", () => {
	it("is the /64 for IPv6, however the address is written", () => {
		const a = throttleAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
		expect(a).toBe("2001:db8:1:2::/64");
		expect(throttleAddress("2001:0db8:0001:0002::1")).toBe(a);
		expect(throttleAddress("2001:DB8:1:2:ffff::")).toBe(a);
	});

	it("keeps different /64s apart", () => {
		expect(throttleAddress("2001:db8:1:3::1")).not.toBe(
			throttleAddress("2001:db8:1:2::1"),
		);
		expect(throttleAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(throttleAddress("::1")).toBe("0:0:0:0::/64");
	});

	it("leaves IPv4 as it is", () => {
		expect(throttleAddress("192.0.2.7")).toBe("192.0.2.7");
		expect(throttleAddress("192.0.2.8")).not.toBe(throttleAddress("192.0.2.7"));
		expect(throttleAddress("::ffff:192.0.2.7")).toBe("192.0.2.7");
	});

	it("is read from CF-Connecting-IP, with one shared bucket when it is absent", () => {
		const req = (ip?: string) =>
			new Request("http://x/", {
				headers: ip ? { "CF-Connecting-IP": ip } : {},
			});
		expect(clientIp(req("2001:db8:1:2::9"))).toBe(
			clientIp(req("2001:db8:1:2::a")),
		);
		expect(clientIp(req())).toBe("unknown");
	});
});

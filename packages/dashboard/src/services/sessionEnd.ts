/**
 * What else a lost session takes with it.
 *
 * api.ts notices a session has gone (a 401) and the auth store holds the
 * session the router asks about. The store imports api.ts, so the store
 * registers itself here rather than api.ts importing the store; and a module
 * of its own leaves the tests that stand in for api.ts none the wiser.
 */
let forget: () => void = () => {};

export function whenSessionEnds(then: () => void): void {
	forget = then;
}

export function sessionEnded(): void {
	forget();
}

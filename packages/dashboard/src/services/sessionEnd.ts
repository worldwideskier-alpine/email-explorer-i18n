/**
 * What else a lost session takes with it.
 *
 * api.ts notices a session has gone (a 401) and the auth store holds the
 * session the router asks about. The store imports api.ts, so the store
 * registers itself here rather than api.ts importing the store; and a module
 * of its own leaves the tests that stand in for api.ts none the wiser.
 */
let forget: () => void = () => {};

/**
 * Which session a request belongs to. Every end of a session moves it on,
 * and api.ts drops an answer to a request sent under an earlier one: the
 * stores were emptied when the session ended, and an answer arriving after
 * that -- the mailbox list, a search -- put the last person's mail back in
 * front of whoever signed in next. A 401 among them ended the new session.
 */
let generation = 0;

export function sessionGeneration(): number {
	return generation;
}

export function whenSessionEnds(then: () => void): void {
	forget = then;
}

export function sessionEnded(): void {
	generation += 1;
	forget();
}

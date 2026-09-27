import type { Env as WorkerEnv } from "../src/types";

// The pool types `env` from "cloudflare:test" as Cloudflare.Env since 0.22;
// ProvidedEnv, which this used to extend, is no longer what it reads.
declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {}
	}
}

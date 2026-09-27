// What Vite answers at import time under the test pool, declared here
// because `vite` is not a dependency of this package for `vite/client`.

declare module "*?raw" {
	const content: string;
	export default content;
}

interface ImportMeta {
	glob<T = unknown>(
		pattern: string | string[],
		options?: { eager?: boolean; query?: string; import?: string },
	): Record<string, T>;
}

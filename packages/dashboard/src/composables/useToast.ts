import { ref } from "vue";

/**
 * What a toast says, or how to say it. A function is asked again every time
 * the toast is drawn, so a toast shown just before the language changes says
 * it in the new one; a string from `t()` was frozen in the language it was
 * made in. See "A message shown to the user is never stored as an
 * already-translated string" in AGENTS.md.
 */
export type ToastMessage = string | (() => string);

export interface Toast {
	id: string;
	message: ToastMessage;
	type: "success" | "error" | "info" | "warning";
	duration?: number;
}

const toasts = ref<Toast[]>([]);

// A counter, not the clock: two toasts in the same millisecond shared an id,
// so one's timeout took both away and the list had a duplicate key.
let lastId = 0;

export function useToast() {
	const addToast = (
		message: ToastMessage,
		type: "success" | "error" | "info" | "warning" = "info",
		duration = 3000,
	) => {
		const id = String(++lastId);
		const toast: Toast = { id, message, type, duration };

		toasts.value.push(toast);

		if (duration > 0) {
			setTimeout(() => {
				removeToast(id);
			}, duration);
		}

		return id;
	};

	const removeToast = (id: string) => {
		toasts.value = toasts.value.filter((t) => t.id !== id);
	};

	const success = (message: ToastMessage, duration?: number) =>
		addToast(message, "success", duration);
	const error = (message: ToastMessage, duration?: number) =>
		addToast(message, "error", duration);
	const info = (message: ToastMessage, duration?: number) =>
		addToast(message, "info", duration);
	const warning = (message: ToastMessage, duration?: number) =>
		addToast(message, "warning", duration);

	return {
		toasts,
		addToast,
		removeToast,
		success,
		error,
		info,
		warning,
	};
}

/** The words a toast shows now. */
export function toastText(toast: Toast): string {
	return typeof toast.message === "function" ? toast.message() : toast.message;
}

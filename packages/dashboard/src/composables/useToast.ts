import { ref } from "vue";

export interface Toast {
	id: string;
	message: string;
	type: "success" | "error" | "info" | "warning";
	duration?: number;
}

const toasts = ref<Toast[]>([]);

// A counter, not the clock: two toasts in the same millisecond shared an id,
// so one's timeout took both away and the list had a duplicate key.
let lastId = 0;

export function useToast() {
	const addToast = (
		message: string,
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

	const success = (message: string, duration?: number) =>
		addToast(message, "success", duration);
	const error = (message: string, duration?: number) =>
		addToast(message, "error", duration);
	const info = (message: string, duration?: number) =>
		addToast(message, "info", duration);
	const warning = (message: string, duration?: number) =>
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

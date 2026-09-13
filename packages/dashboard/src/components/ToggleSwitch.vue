<template>
  <button
    type="button"
    role="switch"
    :id="id"
    :aria-checked="on"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('toggle')"
    class="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-4 focus:ring-indigo-300 dark:focus:ring-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
    :class="on ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'"
  >
    <span
      class="absolute top-[2px] h-5 w-5 rounded-full border border-gray-300 bg-white transition-all duration-200 dark:border-gray-600"
      :class="on ? 'start-[22px]' : 'start-[2px]'"
    ></span>
  </button>
</template>

<script setup lang="ts">
/**
 * A switch whose position is the data and nothing else.
 *
 * This was `<input type="checkbox" :checked="…">` with the track drawn by
 * `peer-checked:`, and it had a fault that no amount of reloading could fix:
 * the browser owns a checkbox's `checked`, a click flips it before any
 * handler runs, and Vue only writes a DOM property back when the *bound*
 * value changed. Re-fetching the truth therefore could not put the switch
 * back, because the truth had not changed -- only the thing the user touched.
 *
 * What that looked like, measured in a browser on the mailbox settings
 * screen: switch the deletion lock off, dismiss the confirmation, and the
 * switch sits in the unlocked position beside the words "Locked: cannot be
 * deleted". Push notifications had the same on the error path -- the request
 * fails and the switch stays where the finger left it.
 *
 * The account list was the third screen with this binding and did *not* show
 * it, which is worth writing down rather than leaving as luck: its reload
 * raises a `loading` flag that swaps the whole list out for a line of text,
 * so the checkbox is built again from scratch rather than patched. A screen
 * got the right answer for a reason that has nothing to do with the lock,
 * and the next edit to that flag would have taken it away silently.
 *
 * A button has no such state. `on` decides what is drawn, every render, so
 * what is on the screen is what the caller last read from the server -- and
 * a click that changes nothing changes nothing on screen either.
 *
 * `role="switch"` with `aria-checked` is what makes it a switch to a screen
 * reader rather than a button; `label` is what it is a switch *for*, because
 * the text beside it is not part of this element.
 */
defineProps<{
	/** Drawn from this, always. Not copied into any state of its own. */
	on: boolean;
	disabled?: boolean;
	/**
	 * Accessible name, for a caller whose visible text is not a `<label>` --
	 * a heading, say. Where there *is* one, give it `id` instead and point the
	 * label's `for` at it: the words then name the switch and click it, which
	 * an `aria-label` does neither of, and a keyboard reaches one control
	 * rather than two.
	 */
	label?: string;
	/** For a `<label for>` outside to attach itself to. */
	id?: string;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
	<!-- Never type=password. With one, the browser takes the form for a
	     sign-in form: it put root's own address and password into the
	     Turnstile keys, and it offers to save whatever is typed as a password
	     for this site -- which it then fills into the sign-in form. Masked by
	     CSS instead. The data-*ignore attributes are for the password managers
	     that look at more than the type. -->
	<input
		v-model="value"
		type="text"
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		data-1p-ignore
		data-lpignore="true"
		data-bwignore
		class="[-webkit-text-security:disc]"
	/>
</template>

<script setup lang="ts">
/**
 * A box for a secret that is not a password -- an API key, a Turnstile
 * secret. Everything else (id, placeholder, classes) is passed through to the
 * input.
 */
const value = defineModel<string>({ required: true });
</script>

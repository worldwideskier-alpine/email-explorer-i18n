import { EmailExplorer } from "../src";

export { MailboxDO } from "../src";

export default EmailExplorer({
	auth: {
		enabled: true,
	},
	// No accountRecovery here. The address password-reset mail is sent from
	// is set on /root and kept in this deployment's bucket (or given as the
	// ACCOUNT_RECOVERY_FROM variable). Written here, it was inherited by
	// every fork, which then sent its resets as an address on this
	// deployment's domain -- and they never arrived.
});

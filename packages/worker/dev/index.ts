import { EmailExplorer } from "../src";
export { MailboxDO } from "../src";

export default EmailExplorer({
	auth: {
        enabled: true,
    },
    // Turns on the "forgot password" flow. Nobody replies to this address --
    // it only has to be able to send, and its domain must be verified in
    // Resend, which is what actually delivers the mail.
    accountRecovery: {
        fromEmail: "noreply@beautifulsnow.co.jp",
    },
});

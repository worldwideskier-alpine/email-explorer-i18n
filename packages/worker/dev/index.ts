import { EmailExplorer } from "../src";
export { MailboxDO } from "../src";

export default EmailExplorer({
	auth: {
        enabled: true,
    },
    // Turns on the "forgot password" flow. Nobody replies to this address --
    // it only has to be able to send, and its domain must be verified in
    // Resend, which is what actually delivers the mail.
    //
    // This is the one real address left in a public repository, and it stays
    // deliberately. It is this deployment's own configuration (the folder it
    // sits in already names the Worker and its bucket), it is a no-reply
    // sender nobody reads, and sending as it needs the Resend key, not
    // knowledge of the string. Its domain is public in DNS anyway: SPF, DKIM
    // and DMARC records have to be there for Resend to deliver at all. Moving
    // it to a secret would only trade that for a silent breakage the first
    // time the secret is missing, since a failed recovery send is swallowed
    // on purpose (see PostForgotPassword -- reporting it would say which
    // addresses have accounts).
    accountRecovery: {
        fromEmail: "noreply@beautifulsnow.co.jp",
    },
});

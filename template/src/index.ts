import { EmailExplorer } from "email-explorer";

export { MailboxDO } from "email-explorer";

// RECOMMENDED: Smart Mode (Default)
// - First user to register automatically becomes admin
// - Registration closes after first user
// - Admins can create additional users via admin panel
// - Perfect for production deployments
export default EmailExplorer({
	auth: {
		enabled: true,
		// registerEnabled not specified = smart mode
	},
});

// OTHER CONFIGURATION OPTIONS:

// Open Registration (Development/Testing)
// export default EmailExplorer({
//   auth: {
//     enabled: true,
//     registerEnabled: true  // Anyone can register
//   }
// })

// No Authentication (Single User)
// export default EmailExplorer({
//   auth: {
//     enabled: false
//   }
// })

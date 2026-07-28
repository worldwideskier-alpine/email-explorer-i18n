# Authentication Guide

Email Explorer uses a secure authentication system to protect your emails and data. This guide will help you create an account, log in, and manage your session.

## Creating Your Account

### First User Registration

When Email Explorer is first deployed, the system is in "smart mode" - the first person to register automatically becomes an administrator.

**To create the first account:**

1. Navigate to your Email Explorer URL
2. You'll be redirected to the login page
3. Click **"Create a new account"** or **"Register"**
4. Fill in the registration form:
   - **Email address**: Your email address (will be your username)
   - **Password**: Choose a strong password (minimum 8 characters)
5. Click **"Create Account"**

**Congratulations!** You're now registered and automatically logged in as an administrator.

### Additional User Registration

After the first user registers, **public registration is automatically closed** for security. New users must be created by an administrator through the [Admin Panel](./admin-panel.md).

If you need an account and see "Registration is closed":
- Contact your administrator to create an account for you
- They can create your account through the Admin Panel

## Logging In

### Standard Login Process

1. Navigate to your Email Explorer URL
2. Enter your credentials:
   - **Email**: The email address you registered with
   - **Password**: Your account password
3. Click **"Log In"**

If successful, you'll be redirected to your mailbox dashboard.

### Session Management

When you log in:
- A secure session is created that lasts **30 days**
- Your session is stored securely using HttpOnly cookies
- You stay logged in even if you close your browser
- Your session automatically expires after 30 days for security

### Failed Login

If login fails, you'll see an error message:
- **"Invalid credentials"**: Check your email and password
- **"User not found"**: The email address isn't registered
- **Connection error**: Check your internet connection

## Staying Logged In

### How Sessions Work

Email Explorer uses session-based authentication:
- When you log in, a secure session token is created
- This token is stored in your browser as a cookie
- The token is automatically sent with every request
- Sessions expire after 30 days of inactivity

### Session Security Features

Your session is protected with:
- **HttpOnly Cookies**: JavaScript cannot access your session (prevents XSS attacks)
- **Secure Flag**: Session only sent over HTTPS
- **SameSite Protection**: Prevents cross-site request forgery (CSRF)
- **30-Day Expiry**: Automatic logout after this period

## Logging Out

To end your session and log out:

1. Click your email address or user icon in the top-right corner
2. Click **"Logout"** or **"Sign Out"**
3. Your session is immediately invalidated
4. You'll be redirected to the login page

**Important**: Always log out when using a shared or public computer!

## Password Requirements

To keep your account secure, passwords must:
- Be at least **8 characters long**
- Should include a mix of:
  - Uppercase letters (A-Z)
  - Lowercase letters (a-z)
  - Numbers (0-9)
  - Special characters (!@#$%^&*)

**Best Practices**:
- Use a unique password (don't reuse from other sites)
- Consider using a password manager
- Never share your password with anyone
- Change your password if you suspect it's compromised

## Troubleshooting

### "Registration is closed" Error

**Cause**: The first user has already registered, and smart mode has closed public registration.

**Solution**: Contact your administrator to create an account for you.

### "Session expired" or Automatic Logout

**Cause**: Your session has expired after 30 days.

**Solution**: Simply log in again with your credentials.

### "Unauthorized" Errors

**Causes**:
- Your session expired
- You're not logged in
- Your session cookie was cleared

**Solution**: Log in again to create a new session.

### Can't Remember Password

**Current Status**: Password reset functionality is not yet available.

**Temporary Solution**: 
- Contact your administrator to reset your password
- They can create a new account or update your password

**Future**: Password reset via email is planned for a future update.

### Login Page Doesn't Load

**Troubleshooting Steps**:
1. Check your internet connection
2. Verify the URL is correct
3. Try clearing your browser cache
4. Try a different browser
5. Contact your administrator if the service is down

### Session Not Persisting

If you keep getting logged out:

**Check**:
- Are cookies enabled in your browser?
- Are you in private/incognito mode? (sessions won't persist)
- Is your browser blocking third-party cookies?

**Solution**:
- Enable cookies for the Email Explorer domain
- Use regular browser mode (not private)
- Add Email Explorer to your browser's allowed sites

## User Roles

### Regular User

Most users have regular user privileges:
- Access to assigned mailboxes
- Can read and send emails
- Can organize folders and contacts
- Cannot create other users
- Cannot grant access to mailboxes

### Administrator

The first registered user becomes an administrator with additional privileges:
- All regular user capabilities
- Access to the Admin Panel
- Can create new users
- Can grant/revoke mailbox access
- Can assign user roles

**See Also**: [Admin Panel Guide](./admin-panel.md) for administrator features

## Security Features

### What We Do to Protect Your Account

1. **Password Hashing**: Passwords are never stored in plain text
2. **Secure Sessions**: Session tokens use cryptographic randomness
3. **HTTPS Only**: All communications are encrypted
4. **Cookie Security**: HttpOnly, Secure, and SameSite flags enabled
5. **Session Expiry**: Automatic logout after 30 days
6. **No Password Exposure**: Passwords never appear in API responses

### What You Should Do

1. **Use a Strong Password**: Follow the password requirements
2. **Log Out on Shared Devices**: Always log out on public computers
3. **Keep Your Credentials Private**: Never share your password
4. **Report Suspicious Activity**: Contact your admin if something seems wrong
5. **Use HTTPS**: Always access Email Explorer via https://

## Privacy

### What Information Do We Store?

- Email address (your username)
- Password hash (not your actual password)
- Session information (for keeping you logged in)
- Your emails and mailbox data

### What Information Is Never Stored?

- Plain text passwords
- Unnecessary personal information
- Browsing history outside Email Explorer

## Frequently Asked Questions

### Can I change my email address?

Not currently. Your email address is your permanent username.

### Can I change my password?

Password change functionality is planned for a future update. For now, contact your administrator.

### Can I have multiple accounts?

Yes, administrators can create multiple accounts for you with different email addresses.

### What happens if I forget my password?

Contact your administrator - they can help reset your password or create a new account.

### Can I stay logged in forever?

No, for security reasons, sessions expire after 30 days. You'll need to log in again after that.

### Is my data encrypted?

Yes, all communication between your browser and Email Explorer uses HTTPS encryption.

### Can administrators see my password?

No, administrators cannot see your password. Passwords are hashed and never stored or displayed in plain text.

### What if someone gets my session cookie?

Session cookies have security protections, but if compromised, log out immediately to invalidate the session.

## Next Steps

- **New User**: Visit the [Reply & Forward](./reply-forward.md) guide to start using email
- **Administrator**: Check out the [Admin Panel](./admin-panel.md) guide
- **Compose Emails**: Learn about the [Rich Text Editor](./rich-text-editor.md)

---

**Need Help?** Contact your system administrator or check the troubleshooting section above.

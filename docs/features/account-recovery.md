# Account Recovery Guide

Account Recovery allows users to reset their forgotten passwords via email. This guide covers setup, configuration, and usage.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [User Guide](#user-guide)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Overview

Email Explorer's Account Recovery feature provides a secure, email-based password reset mechanism. When enabled, users who forget their passwords can request a password reset link via email, which they can use to set a new password.

**Key Features:**
- 🔐 Secure token-based password reset
- 📧 Email-based recovery links
- ⏱️ Time-limited reset tokens
- 🛡️ No admin intervention required
- 🔒 Passwords never transmitted via email

## Prerequisites

To enable Account Recovery, you need:

1. **A sender address on a domain verified in [Resend](https://resend.com)**
   - Mail leaves through Resend, not through Cloudflare
   - Used as the "from" address for recovery emails
   - Example: `noreply@yourdomain.com`

2. **A Resend API key for each person who may need a reset**
   - A reset is the reset person's own mail, so it is sent with *their* key,
     set on their own screen (`/admin`, or `/root` for root). There is no
     deployment-wide key to fall back on.
   - **Somebody with no key set gets no reset mail**, and is not told so: the
     page answers the same whatever happened, so that it cannot be used to
     find out which addresses have accounts.

## Configuration

### Enable Account Recovery

Set the **password reset sender** on `/root`, signed in as root. That is the
whole of it: the address is kept in the deployment's bucket, and "forgot
password" turns on as soon as it is saved. It must be on a domain verified in
Resend.

Two other sources exist. The deployment's `ACCOUNT_RECOVERY_FROM` variable or
secret (see [Deploying your own](../deploying-your-own.md)) takes precedence
over `/root`, and `/root` says so when it does. An `accountRecovery` option in
code, for somebody embedding the package, comes last: it is used only when
neither of the others is set, because source code is what a fork inherits.
The order is: the variable, then `/root`, then code.

```typescript
export default EmailExplorer({
  accountRecovery: {
    fromEmail: 'noreply@yourdomain.com'  // Your verified email address
  }
});
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `accountRecovery.fromEmail` | string | Yes | Email address to send recovery links from |

### Disable Account Recovery

Remove the sender on `/root` (and leave `ACCOUNT_RECOVERY_FROM` unset). With
no sender anywhere the flow is off. In code, that is omitting the option:

```typescript
export default EmailExplorer({
  // accountRecovery not specified = disabled
});
```

## How It Works

### Password Reset Flow

1. **User Requests Reset**
   - User clicks "Forgot your password?" on login page
   - Enters their email address
   - System generates a secure reset token

2. **Email Sent**
   - Reset link with token is sent to user's email
   - Link is valid for 1 hour
   - User receives email from configured `fromEmail` address

3. **User Resets Password**
   - User clicks link in email
   - Enters new password (minimum 8 characters)
   - Password is updated in the system

4. **Confirmation**
   - User is redirected to login page
   - Can now log in with new password

### Technical Details

**Token Generation:**
- Cryptographically secure random tokens
- Stored in R2 with 1-hour expiration
- One-time use only

**Security Measures:**
- Tokens are single-use
- Tokens expire after 1 hour
- Password hashed with PBKDF2-SHA256 (100,000 iterations, per-user salt)
- HTTPS required for all communications
- The response is identical whether or not the address has an account, so this
  endpoint cannot be used to find out which addresses are worth attacking. A
  send that fails is logged rather than reported back, for the same reason.
- Requests are rate limited per address and per IP, so the rate at which they
  are accepted does not answer that question either

**Email Format:**
- Plain text and HTML versions
- Includes user-friendly reset link
- Contains security information

## User Guide

### Requesting a Password Reset

1. **Go to Login Page**
   - Navigate to your Email Explorer instance
   - Click "Sign in to Email Explorer"

2. **Click "Forgot your password?"**
   - Link appears only when Account Recovery is enabled
   - Located below the sign-in button

3. **Enter Your Email**
   - Type the email address associated with your account
   - Click "Send Reset Link"

4. **Check Your Email**
   - Look for email from `noreply@yourdomain.com`
   - Check spam folder if not in inbox
   - Link is valid for 1 hour

5. **Reset Your Password**
   - Click the reset link in the email
   - Enter your new password (minimum 8 characters)
   - Click "Reset Password"

6. **Log In**
   - Return to login page
   - Use your email and new password
   - You're now logged in!

### Password Requirements

- **Minimum Length:** 8 characters
- **Recommended:** Mix of uppercase, lowercase, numbers, and symbols
- **Unique:** Different from previous passwords

### What If You Don't Receive the Email?

1. **Check Spam Folder**
   - Recovery emails may be filtered as spam
   - Add `noreply@yourdomain.com` to contacts

2. **Verify Email Address**
   - Ensure you entered the correct email
   - Try again with the correct address

3. **Wait a Moment**
   - Email delivery can take a few seconds
   - Refresh your inbox

4. **Contact root**
   - If still not received, ask whoever runs the deployment (root)
   - Root can set a new password for you on `/root`

## Security

### Best Practices

**For Users:**
- ✅ Use strong, unique passwords
- ✅ Don't share reset links with others
- ✅ Delete recovery emails after use
- ✅ Log out from shared devices
- ❌ Don't click reset links from suspicious emails

**For Administrators:**
- ✅ Use a dedicated noreply email address
- ✅ Monitor for abuse patterns
- ✅ Keep Cloudflare updated
- ✅ Review user access regularly
- ❌ Don't share the `fromEmail` address

### Token Security

- **Single Use:** Each token can only be used once
- **Time Limited:** Tokens expire after 1 hour
- **Cryptographically Secure:** Generated with Web Crypto API
- **Stored Securely:** Tokens stored in R2 with encryption

### Email Security

- **HTTPS Only:** All links use HTTPS
- **No Passwords in Email:** Passwords are never sent via email
- **Verified Domain:** Emails are sent from a domain verified in Resend
- **SPF/DKIM:** Resend signs the mail for that domain

## Troubleshooting

### "Account Recovery is not enabled"

**Problem:** User sees message that account recovery is disabled

**Solutions:**
1. Set a password reset sender on `/root` (or `ACCOUNT_RECOVERY_FROM`)
2. Check that the address is on a domain verified in Resend
3. Reload the page

### "Invalid or expired token"

**Problem:** Reset link doesn't work

**Solutions:**
1. Token expires after 1 hour - request a new one
2. Each token can only be used once
3. Check that you're using the correct link
4. Try requesting a new reset link

### "Email not received"

**Problem:** User doesn't receive recovery email

**Solutions:**
1. Check spam/junk folder
2. Verify email address is correct
3. Wait a few seconds and refresh inbox
4. Check that the person being reset has a Resend API key set on their own
   screen -- without one no reset mail is sent, and the page does not say so
5. Check that the sender address is on a domain verified in Resend

### "Password reset failed"

**Problem:** Error when trying to set new password

**Solutions:**
1. Password must be at least 8 characters
2. Ensure token hasn't expired (1 hour)
3. Try requesting a new reset link
4. Contact administrator if issue persists

### "Forgot password link not showing"

**Problem:** "Forgot your password?" link missing from login page

**Solutions:**
1. Account Recovery must be enabled: a sender set on `/root`, or
   `ACCOUNT_RECOVERY_FROM`
2. Refresh page (Ctrl+F5 or Cmd+Shift+R)
3. Clear browser cache
4. Try different browser

## API Endpoints

Account Recovery uses the following API endpoints:

### Request Password Reset

```
POST /api/v1/auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}

Response:
{
  "status": "Password reset email sent"
}
```

### Reset Password

```
POST /api/v1/auth/reset-password
Content-Type: application/json

{
  "token": "reset-token-from-email",
  "newPassword": "newPassword123"
}

Response:
{
  "status": "Password reset successfully"
}
```

### Check Settings

```
GET /api/v1/settings

Response:
{
  "auth": {
    "enabled": true,
    "registerEnabled": true
  },
  "accountRecovery": {
    "enabled": true
  }
}
```

## Related Documentation

- [Authentication Guide](authentication.md) - Account creation and login
- [Admin Panel Guide](admin-panel.md) - User management
- [Deploying your own](../deploying-your-own.md) - Where the sender and keys are set

## Support

For issues or questions about Account Recovery:

1. **Check this guide** - Most common issues are covered above
2. **Review logs** - Check Cloudflare Worker logs for errors
3. **GitHub Issues** - [Report issues on GitHub](https://github.com/G4brym/email-explorer/issues)
4. **Contact Admin** - Reach out to your Email Explorer administrator

---

**Last Updated:** December 2024

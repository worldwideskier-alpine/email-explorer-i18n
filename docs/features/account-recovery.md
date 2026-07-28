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

1. **Cloudflare Account** with Email Sending enabled
   - [Enable Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
   - Requires a verified domain in Cloudflare

2. **Valid Email Address**
   - Must be a valid email on your Cloudflare account
   - Used as the "from" address for recovery emails
   - Example: `noreply@yourdomain.com`

3. **Authentication Enabled**
   - Account Recovery requires `auth.enabled: true`

## Configuration

### Enable Account Recovery

Edit your worker configuration file (typically `src/index.ts` or `dev/index.ts`):

```typescript
export default EmailExplorer({
  auth: {
    enabled: true
  },
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

To disable Account Recovery, simply remove or omit the `accountRecovery` configuration:

```typescript
export default EmailExplorer({
  auth: {
    enabled: true
  }
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
   - Link is valid for 24 hours
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
- Stored in R2 with 24-hour expiration
- One-time use only

**Security Measures:**
- Tokens are single-use
- Tokens expire after 24 hours
- Password hashed with Web Crypto API (SHA-256)
- HTTPS required for all communications

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
   - Link is valid for 24 hours

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

4. **Contact Administrator**
   - If still not received, contact your admin
   - Admin can manually reset your password

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
- **Time Limited:** Tokens expire after 24 hours
- **Cryptographically Secure:** Generated with Web Crypto API
- **Stored Securely:** Tokens stored in R2 with encryption

### Email Security

- **HTTPS Only:** All links use HTTPS
- **No Passwords in Email:** Passwords are never sent via email
- **Verified Domain:** Emails sent from your verified Cloudflare domain
- **SPF/DKIM:** Cloudflare handles email authentication

## Troubleshooting

### "Account Recovery is not enabled"

**Problem:** User sees message that account recovery is disabled

**Solutions:**
1. Verify `accountRecovery.fromEmail` is configured
2. Check that email address is valid
3. Redeploy worker after configuration change
4. Clear browser cache and try again

### "Invalid or expired token"

**Problem:** Reset link doesn't work

**Solutions:**
1. Token expires after 24 hours - request a new one
2. Each token can only be used once
3. Check that you're using the correct link
4. Try requesting a new reset link

### "Email not received"

**Problem:** User doesn't receive recovery email

**Solutions:**
1. Check spam/junk folder
2. Verify email address is correct
3. Wait a few seconds and refresh inbox
4. Check that Email Sending is enabled in Cloudflare
5. Verify `fromEmail` address is valid

### "Password reset failed"

**Problem:** Error when trying to set new password

**Solutions:**
1. Password must be at least 8 characters
2. Ensure token hasn't expired (24 hours)
3. Try requesting a new reset link
4. Contact administrator if issue persists

### "Forgot password link not showing"

**Problem:** "Forgot your password?" link missing from login page

**Solutions:**
1. Account Recovery must be enabled in configuration
2. Check that `accountRecovery.fromEmail` is set
3. Refresh page (Ctrl+F5 or Cmd+Shift+R)
4. Clear browser cache
5. Try different browser

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
- [Security Best Practices](../security.md) - General security guidelines

## Support

For issues or questions about Account Recovery:

1. **Check this guide** - Most common issues are covered above
2. **Review logs** - Check Cloudflare Worker logs for errors
3. **GitHub Issues** - [Report issues on GitHub](https://github.com/G4brym/email-explorer/issues)
4. **Contact Admin** - Reach out to your Email Explorer administrator

---

**Last Updated:** December 2024

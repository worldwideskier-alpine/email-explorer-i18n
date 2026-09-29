# Email Explorer - Feature Documentation

Welcome to Email Explorer! This documentation will help you understand and use all the features available in this email client.

## Available Features

### 🔐 [Authentication](./authentication.md)
Learn how to create an account, log in, and manage your session.
- The first account, and everybody else's
- Signing in and sessions
- Rate limiting and bot protection
- Your own account and sign-in addresses

### 🔑 [Account Recovery](./account-recovery.md)
Resetting a forgotten password by email.
- Setting the reset sender on `/root`
- Requesting and using a reset link

### 👥 [Admin Panel](./admin-panel.md)
The two management screens: `/admin` for your own account, `/root` for the deployment.
- Root and administrator roles
- Creating and deleting accounts (root)
- Your sign-in addresses and your own sending key
- Nightly maintenance and leftover attachments (root)

### ✍️ [Rich Text Editor](./rich-text-editor.md)
Compose beautiful, formatted emails with our powerful editor.
- Text formatting (bold, italic, underline)
- Colors and highlights
- Lists and headings
- Links and alignment
- HTML source editing

### ↩️ [Reply & Forward](./reply-forward.md)
Respond to emails and forward them to others.
- Reply to sender
- Reply to all recipients
- Forward emails
- Email threading

## Getting Started

If you're new to Email Explorer:

1. **First Time Setup**
   - Start with [Authentication](./authentication.md) to create your account
   - The first account to register becomes root, and registration closes behind it

2. **Accounts and Mailboxes**
   - Root creates everybody else's accounts on `/root` (see the [Admin Panel](./admin-panel.md))
   - Each administrator creates their own mailboxes and holds them; nobody is given access to somebody else's mailbox
   - Each administrator sets their own Resend key on `/admin` to send mail

3. **Using Email**
   - Compose emails with the [Rich Text Editor](./rich-text-editor.md)
   - Learn how to [Reply & Forward](./reply-forward.md) messages

## Quick Reference

### For Everybody
- [How to sign in](./authentication.md#signing-in)
- [How to compose formatted emails](./rich-text-editor.md#basic-formatting)
- [How to reply to emails](./reply-forward.md#how-to-reply-to-an-email)
- [How to forward emails](./reply-forward.md#how-to-forward-an-email)
- [Your sign-in addresses](./admin-panel.md#addresses-you-sign-in-with)
- [Your outbound mail key](./admin-panel.md#outbound-mail-api-key)

### For Root
- [Understanding the roles](./admin-panel.md#who-is-who)
- [How to create accounts](./admin-panel.md#accounts)
- [How to set somebody's password](./admin-panel.md#setting-a-password)
- [How to delete a person](./admin-panel.md#deleting-a-person)

## Need Help?

If you can't find what you're looking for:
1. Check the relevant feature documentation
2. Look at the troubleshooting sections in each guide
3. Ask whoever runs your deployment (root)
4. Report issues on GitHub

## About This Documentation

This documentation is organized by feature to help you quickly find the information you need. Each guide includes:
- Step-by-step instructions
- Examples
- Troubleshooting tips

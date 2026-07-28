# Admin Panel Guide

The Admin Panel is a powerful tool for administrators to manage users and control access to mailboxes. This guide will help you understand and use all administrative features.

## Accessing the Admin Panel

### Prerequisites

- You must be logged in as an administrator
- Only administrators can see and access the Admin Panel

### Opening the Admin Panel

1. Log in to Email Explorer
2. Look for the **"Admin Panel"** button in the top navigation bar
3. Click to open the Admin Panel

**Note**: If you don't see the Admin Panel button, you're not logged in as an administrator.

## Overview

The Admin Panel is organized into main sections:

1. **User Management** - Create and view users
2. **Access Management** - Grant and revoke mailbox access
3. **Users List** - View all registered users

## Creating New Users

As an administrator, you can create accounts for other users.

### Step-by-Step Process

1. Open the **Admin Panel**
2. Locate the **"Register New User"** section at the top
3. Fill in the form:
   - **Email Address**: The user's email address (becomes their username)
   - **Password**: Initial password (minimum 8 characters)
4. Click **"Create User"**

### After Creating a User

- The new user appears in the Users List immediately
- The user can log in with the credentials you provided
- New users are **not** administrators by default
- The user list refreshes automatically

### Best Practices

- **Use Strong Passwords**: Even for initial passwords
- **Communicate Securely**: Share credentials through secure channels
- **Recommend Password Changes**: Users should change their password after first login (when feature is available)

## Viewing Users

### Users List

The Users List shows all registered users in the system.

**Information Displayed**:
- **Email**: User's email address/username
- **Role**: Either "Admin" or "User"
- **Created**: When the account was created
- **Actions**: Management options for each user

### Refreshing the List

Click the **"Refresh"** button to reload the users list and see the latest changes.

## Managing Mailbox Access

One of the most important admin features is controlling which users can access which mailboxes.

### Opening Access Management

1. Find the user in the Users List
2. Click **"Manage Access"** next to their name
3. A modal window opens showing access management options

### Granting Mailbox Access

To give a user access to a mailbox:

1. Open the **Manage Access** modal for the user
2. In the **"Grant Mailbox Access"** section:
   - **Mailbox ID**: Enter the mailbox email address (e.g., `john@company.com`)
   - **Role**: Select the appropriate permission level
3. Click **"Grant Access"**
4. A success message confirms the access was granted

### Revoking Mailbox Access

To remove a user's access to a mailbox:

1. Open the **Manage Access** modal for the user
2. In the **"Revoke Mailbox Access"** section:
   - **Mailbox ID**: Enter the mailbox email address to revoke
3. Click **"Revoke Access"**
4. Confirm the action when prompted
5. A success message confirms the access was revoked

## User Roles

Email Explorer uses a role-based permission system. There are two types of roles:

### Account Roles

**Administrator**
- Full system access
- Can access the Admin Panel
- Can create and manage users
- Can grant and revoke mailbox access
- Can access any mailbox (if granted)

**User** (Regular User)
- Can only access assigned mailboxes
- Cannot access Admin Panel
- Cannot create users
- Cannot manage permissions

### Mailbox Permission Roles

When granting mailbox access, you assign one of four permission levels:

#### Owner
**Full Control of the Mailbox**
- Can read, send, and delete emails
- Can create and manage folders
- Can manage mailbox settings
- Can delete the mailbox
- Highest level of access

**When to Use**: For the mailbox owner or primary user

#### Admin
**Manage Settings and Users**
- Can read and send emails
- Can create and manage folders
- Can manage mailbox settings
- Can grant/revoke access for other users
- **Cannot** delete the mailbox

**When to Use**: For trusted users who help manage the mailbox

#### Write
**Send and Manage Emails**
- Can read and send emails
- Can create and manage folders
- Can organize emails
- Limited settings access
- **Cannot** delete mailbox or manage users

**When to Use**: For team members who need to send emails from the mailbox

#### Read
**View-Only Access**
- Can only view emails
- **Cannot** send emails
- **Cannot** create folders
- **Cannot** modify settings
- Read-only access to everything

**When to Use**: For auditors, supervisors, or users who only need to monitor emails

## Role Selection Guide

Choose the right role based on what the user needs to do:

| Task | Owner | Admin | Write | Read |
|------|-------|-------|-------|------|
| Read emails | ✅ | ✅ | ✅ | ✅ |
| Send emails | ✅ | ✅ | ✅ | ❌ |
| Create folders | ✅ | ✅ | ✅ | ❌ |
| Manage contacts | ✅ | ✅ | ✅ | ❌ |
| Mailbox settings | ✅ | ✅ | Limited | ❌ |
| Grant/revoke access | ✅ | ✅ | ❌ | ❌ |
| Delete mailbox | ✅ | ❌ | ❌ | ❌ |

## Common Scenarios

### Scenario 1: New Employee Needs Email Access

**Situation**: A new employee joins and needs access to a team mailbox.

**Steps**:
1. Create a new user account for them
2. Grant them **Write** access to the team mailbox
3. They can now read and send emails from that mailbox

### Scenario 2: Manager Needs to Monitor Emails

**Situation**: A manager needs to review emails but not send them.

**Steps**:
1. Create a user account if they don't have one
2. Grant them **Read** access to the mailbox
3. They can view all emails but cannot send or modify

### Scenario 3: Assistant Manages Executive's Email

**Situation**: An assistant needs full control over an executive's mailbox.

**Steps**:
1. Create a user account for the assistant
2. Grant them **Admin** access to the executive's mailbox
3. They can manage emails, folders, and settings (but cannot delete the mailbox)

### Scenario 4: Contractor Needs Temporary Access

**Situation**: A contractor needs access for a project.

**Steps**:
1. Create a user account
2. Grant appropriate access (probably **Write** or **Read**)
3. When project ends: **Revoke** their access
4. Their user account remains but they can no longer access the mailbox

### Scenario 5: User Changes Roles

**Situation**: A user's responsibilities change and they need different permissions.

**Steps**:
1. Revoke their current access
2. Grant new access with the appropriate role
3. **Note**: You must revoke before granting a new role

## Admin Panel Interface

### Layout

```
┌─────────────────────────────────────────────┐
│  Admin Panel            [← Back to Home]    │
│  Manage users and mailbox access            │
├─────────────────────────────────────────────┤
│  Register New User                          │
│  ┌──────────────┬─────────────────────┐    │
│  │ Email        │ Password            │    │
│  └──────────────┴─────────────────────┘    │
│  [Create User]                              │
├─────────────────────────────────────────────┤
│  Users                        [Refresh]     │
│  ┌─────────────────────────────────────┐   │
│  │ Email     │ Role  │ Created │ Actions│   │
│  │ admin@... │ Admin │ Nov 15  │ Manage │   │
│  │ user@...  │ User  │ Nov 20  │ Manage │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Access Management Modal

```
┌──────────────────────────────────────┐
│  Manage Access for user@example.com  │  [X]
├──────────────────────────────────────┤
│  Grant Mailbox Access                │
│  ┌───────────────┬────────────────┐  │
│  │ Mailbox ID    │ Role           │  │
│  │ team@co.com   │ [Write ▼]      │  │
│  └───────────────┴────────────────┘  │
│  [Grant Access]  [Revoke Access]     │
│                                       │
│  Role Descriptions:                  │
│  • Owner: Full control               │
│  • Admin: Manage settings & users    │
│  • Write: Send and manage emails     │
│  • Read: View emails only            │
└──────────────────────────────────────┘
```

## Success and Error Messages

### Success Messages

- ✅ **"User created successfully!"** - User account was created
- ✅ **"Access granted successfully!"** - Mailbox access was granted
- ✅ **"Access revoked successfully!"** - Mailbox access was removed
- ✅ **"Users list refreshed"** - List updated with latest data

### Error Messages

- ❌ **"Failed to create user"** - User creation failed (check if email already exists)
- ❌ **"Failed to grant access"** - Access grant failed (check mailbox ID)
- ❌ **"Failed to revoke access"** - Revoke failed (user may not have access)
- ❌ **"Admin privileges required"** - You're not an administrator

## Troubleshooting

### Can't See Admin Panel Button

**Problem**: The Admin Panel button doesn't appear.

**Causes**:
- You're not logged in as an administrator
- Your session expired

**Solution**: 
- Verify you're logged in
- Check with another administrator to confirm your admin status
- Log out and log back in

### "Admin privileges required" Error

**Problem**: You get this error when trying to access admin features.

**Cause**: Your account is not an administrator.

**Solution**: Contact an existing administrator to grant you admin privileges.

### User Creation Fails

**Problem**: Creating a new user returns an error.

**Common Causes**:
- Email address already exists (users must have unique emails)
- Password is too short (must be at least 8 characters)
- Network connection issues

**Solutions**:
- Check if the email is already registered (look in Users List)
- Ensure password meets requirements
- Try again or refresh the page

### Access Grant Fails

**Problem**: Granting mailbox access returns an error.

**Common Causes**:
- Invalid mailbox ID format
- Network issues
- User already has access with a different role

**Solutions**:
- Double-check the mailbox email address format
- Try revoking existing access first, then granting new access
- Refresh and try again

### Modal Won't Close

**Problem**: The Access Management modal won't close.

**Solution**:
- Click the X button in the top-right corner
- Click outside the modal (on the dark background)
- Press the Escape key
- Refresh the page if needed

## Security Best Practices

### For Administrators

1. **Principle of Least Privilege**
   - Only grant the minimum access level needed
   - Start with Read access and increase if necessary
   - Review and revoke unused access regularly

2. **Regular Access Audits**
   - Periodically review who has access to which mailboxes
   - Remove access for departed employees immediately
   - Check for any unusual access patterns

3. **Strong Passwords**
   - Use strong initial passwords when creating accounts
   - Encourage users to change their passwords
   - Never share administrator credentials

4. **Documentation**
   - Keep a record of why access was granted
   - Document role assignments
   - Note when access should be reviewed or revoked

5. **Secure Communication**
   - Share credentials through secure channels only
   - Never send passwords via unencrypted email
   - Use temporary passwords when possible

## Frequently Asked Questions

### Can I make someone else an administrator?

Not currently through the UI. Administrator status is set when the account is created (first user only) or through backend configuration.

### Can I delete a user account?

User deletion is not currently available through the Admin Panel. Users can be created but not deleted via the UI.

### Can I see what mailboxes a user has access to?

Not directly in the current version. You manage access by user, so you know what you've granted, but there's no "view all access" feature yet.

### What happens when I revoke access?

The user immediately loses access to that mailbox. They won't be able to read or send emails from it. Their user account remains active.

### Can a user have different roles on different mailboxes?

Yes! A user can be:
- Owner of their personal mailbox
- Admin of a team mailbox
- Read-only on a department mailbox
Each mailbox access is independent.

### How many users can I create?

There's no hard limit. You can create as many users as your deployment can handle.

### Can users request access themselves?

No, users cannot request or grant themselves access. All access must be granted by an administrator.

### What if I accidentally revoke the wrong access?

Simply grant access again with the appropriate role. Access can be revoked and re-granted as needed.

## Tips and Tricks

### Efficient User Management

- **Create users in batches**: Create all new users at once, then grant access
- **Use consistent naming**: Consider a standard format for user emails
- **Test with Read access**: Grant Read access first, then upgrade if needed

### Organizing Access

- **Start restrictive**: Begin with minimal access and increase as needed
- **Document externally**: Keep a spreadsheet of who has access to what
- **Regular reviews**: Schedule quarterly access reviews

### Communication

- **Welcome messages**: Send new users a welcome email with their credentials
- **Role explanations**: Explain to users what their role allows them to do
- **Change notifications**: Inform users when their access changes

## Next Steps

Now that you understand the Admin Panel:

1. **Create Your First User**: Try creating a test user account
2. **Grant Test Access**: Practice granting and revoking access
3. **Review Roles**: Make sure you understand the permission levels
4. **Set Up Your Team**: Create accounts for your team members

## Related Documentation

- [Authentication Guide](./authentication.md) - Understanding user accounts and login
- [Reply & Forward](./reply-forward.md) - Features available to all users
- [Rich Text Editor](./rich-text-editor.md) - Email composition features

---

**Questions?** This guide covered all admin features. If you need help, refer to the troubleshooting section or contact support.

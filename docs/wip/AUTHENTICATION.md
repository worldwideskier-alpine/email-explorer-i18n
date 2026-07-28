# Authentication & User Management

Email Explorer now includes a comprehensive authentication system to secure mailbox access and support multiple users.

## Overview

The authentication system uses a dual-purpose Durable Object architecture:
- The same `MailboxDO` class handles both authentication (when accessed via the special name "AUTH") and mailbox operations
- User data, sessions, and permissions are stored securely in the AUTH Durable Object
- Password hashing uses the Web Crypto API (SHA-256)
- Sessions are JWT-like tokens with 30-day expiry

## Configuration Modes

### Smart Mode (Recommended)

Perfect for production deployments. The first user to register automatically becomes admin, then registration closes.

```typescript
import { EmailExplorer } from "email-explorer";

export default EmailExplorer({
  auth: {
    enabled: true
    // registerEnabled not specified = smart mode
  }
});
```

**Workflow:**
1. Deploy your worker with smart mode enabled (default)
2. First user registers → becomes admin automatically
3. Registration endpoint automatically closes after first user
4. Admin can create additional users via admin panel
5. Admin can grant mailbox access to users

### Open Registration Mode

Useful for development and testing. Anyone can register an account.

```typescript
export default EmailExplorer({
  auth: {
    enabled: true,
    registerEnabled: true
  }
});
```

### Locked Down Mode

Only admins can create users. Public registration is disabled.

```typescript
export default EmailExplorer({
  auth: {
    enabled: true,
    registerEnabled: false
  }
});
```

### No Authentication Mode

For single-user deployments or testing. No authentication required.

```typescript
export default EmailExplorer({
  auth: {
    enabled: false
  }
});
```

## API Endpoints

### Public Endpoints

#### Register
```
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Response (201):**
```json
{
  "id": "user-uuid",
  "email": "user@example.com",
  "isAdmin": true,
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000
}
```

#### Login
```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "your-password"
}
```

**Response (200):**
```json
{
  "id": "session-uuid",
  "userId": "user-uuid",
  "email": "user@example.com",
  "isAdmin": true,
  "expiresAt": 1234567890000
}
```

Sets an HttpOnly cookie: `session=<session-id>`

#### Logout
```
POST /api/v1/auth/logout
```

**Response (200):**
```json
{
  "status": "logged out"
}
```

#### Get Current User
```
GET /api/v1/auth/me
Authorization: Bearer <session-token>
```

**Response (200):**
```json
{
  "id": "session-uuid",
  "userId": "user-uuid",
  "email": "user@example.com",
  "isAdmin": true,
  "expiresAt": 1234567890000
}
```

### Admin-Only Endpoints

All admin endpoints require a valid session with admin privileges.

#### Register User (Admin)
```
POST /api/v1/auth/admin/register
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{
  "email": "newuser@example.com",
  "password": "user-password"
}
```

**Response (201):**
```json
{
  "id": "user-uuid",
  "email": "newuser@example.com",
  "isAdmin": false,
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000
}
```

#### Get All Users
```
GET /api/v1/auth/admin/users
Authorization: Bearer <admin-session-token>
```

**Response (200):**
```json
[
  {
    "id": "user-uuid",
    "email": "user@example.com",
    "isAdmin": true,
    "createdAt": 1234567890000,
    "updatedAt": 1234567890000
  }
]
```

#### Update User
```
PUT /api/v1/auth/admin/users/:userId
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{
  "isAdmin": true
}
```

**Response (200):**
```json
{
  "status": "updated"
}
```

#### Grant Mailbox Access
```
POST /api/v1/auth/admin/grant-access
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{
  "userId": "user-uuid",
  "mailboxId": "mailbox@example.com",
  "role": "read"
}
```

**Roles:**
- `owner` - Full control over the mailbox
- `admin` - Can manage mailbox settings and users
- `write` - Can send emails and create folders
- `read` - Read-only access

**Response (200):**
```json
{
  "status": "access granted"
}
```

#### Revoke Mailbox Access
```
POST /api/v1/auth/admin/revoke-access
Authorization: Bearer <admin-session-token>
Content-Type: application/json

{
  "userId": "user-uuid",
  "mailboxId": "mailbox@example.com"
}
```

**Response (200):**
```json
{
  "status": "access revoked"
}
```

## Authentication Flow

### Session Management

Sessions are managed using tokens stored in HttpOnly cookies or Authorization headers:

**Cookie:**
```
Cookie: session=<session-id>
```

**Authorization Header:**
```
Authorization: Bearer <session-id>
```

Sessions expire after 30 days. The system automatically validates sessions and checks expiry on each request.

### Protected Routes

When authentication is enabled, all routes except the following are protected:
- `/api/v1/auth/register`
- `/api/v1/auth/login`
- `/api/docs`
- `/api/openapi.json`

Unauthenticated requests to protected routes return:
```json
{
  "error": "Unauthorized"
}
```
Status: 401

## Security Features

### Password Security
- Passwords are hashed using SHA-256 via the Web Crypto API
- Plain passwords are never stored
- Minimum password length: 8 characters

### Session Security
- Sessions use cryptographically random UUIDs
- HttpOnly cookies prevent XSS attacks
- Secure flag ensures HTTPS-only transmission
- SameSite=Strict prevents CSRF attacks

### Role-Based Access Control (RBAC)
- Admin users have full system access
- Regular users have access only to assigned mailboxes
- Mailbox permissions are granular (owner, admin, write, read)

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Sessions Table
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### User Mailboxes Table
```sql
CREATE TABLE user_mailboxes (
  user_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, mailbox_id)
);
```

## Migration from No-Auth Setup

If you're upgrading from a version without authentication:

1. **Backup your data** - Export important emails before upgrading
2. **Update your code** - Pull the latest version with auth support
3. **Choose your auth mode** - Update `src/index.ts` with desired configuration
4. **Deploy** - Run `wrangler deploy`
5. **Register first user** - Visit your worker URL and register (becomes admin)
6. **Grant access** - Use admin panel to grant users access to existing mailboxes

Existing mailboxes continue to work. The AUTH Durable Object is created separately and doesn't affect mailbox data.

## Troubleshooting

### "Registration is closed" error
- Smart mode is enabled and a user already exists
- Login with the existing admin account or have an admin create your account

### "Unauthorized" on valid requests
- Session may have expired (30 days)
- Login again to get a new session
- Check that cookies are enabled in your browser

### Password requirements
- Minimum 8 characters
- Use a strong, unique password
- Consider using a password manager

## Architecture Notes

### Dual-Purpose Durable Object

The `MailboxDO` class automatically detects its purpose:

```typescript
// Auth singleton - uses special name 'AUTH'
const authDO = env.MAILBOX.get(env.MAILBOX.idFromName('AUTH'));

// Regular mailbox - uses email address or other identifier
const mailboxDO = env.MAILBOX.get(env.MAILBOX.idFromString('user@example.com'));
```

This design:
- Simplifies deployment (only one DO class to manage)
- Isolates auth data for security
- Leverages existing Durable Object infrastructure
- No additional bindings or configurations needed

### Performance Considerations

- Sessions are validated on each protected request
- Session validation requires a Durable Object call (low latency within Cloudflare)
- Consider implementing session caching for high-traffic deployments
- The AUTH DO is a singleton, so all auth operations go through one instance

## Future Enhancements

Potential additions to the auth system:
- Two-factor authentication (2FA)
- OAuth/SSO integration
- API key authentication
- Rate limiting on auth endpoints
- Password reset flow
- Email verification
- Audit logging

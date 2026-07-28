# Admin Panel - Complete Implementation

## ✅ What Was Added

### 1. **Admin Panel View** (`src/views/Admin.vue`)

A comprehensive admin dashboard with:

#### User Management
- **Register New Users** form
  - Email and password fields
  - Creates non-admin users
  - Auto-refresh user list after creation

- **Users List** table
  - Shows all registered users
  - Displays email, role (Admin/User), and creation date
  - Refresh button to reload users
  - "Manage Access" button for each user

#### Mailbox Access Management
- **Modal interface** for each user
  - Grant mailbox access with role selection
  - Revoke mailbox access
  - Role options: Owner, Admin, Write, Read
  - Success/error feedback

#### Features
- ✅ Clean, modern UI with Tailwind CSS
- ✅ Responsive design (mobile-friendly)
- ✅ Real-time error/success messages
- ✅ Loading states for all actions
- ✅ Confirmation prompt for revoke action
- ✅ Role descriptions tooltip

### 2. **Admin API Endpoints** (`src/services/api.ts`)

Added 4 new admin endpoints:

```typescript
adminRegisterUser(email, password)     // POST /api/v1/auth/admin/register
adminListUsers()                        // GET  /api/v1/auth/admin/users
adminGrantAccess(userId, mailboxId, role) // POST /api/v1/auth/admin/grant-access
adminRevokeAccess(userId, mailboxId)   // POST /api/v1/auth/admin/revoke-access
```

### 3. **Router Updates** (`src/router/index.ts`)

- **New route**: `/admin` → Admin Panel
- **Meta flags**: `requiresAuth: true`, `requiresAdmin: true`
- **Navigation guard**: Checks `authStore.isAdmin` before allowing access
- **Redirect**: Non-admin users redirected to Home

### 4. **Home View Updates** (`src/views/Home.vue`)

- **Admin Panel button** visible only to admins
- Positioned in header next to Logout button
- Styled with indigo color to stand out

## 🎯 User Flow

### Admin Actions

1. **Access Admin Panel**
   - Login as admin
   - See "Admin Panel" button in header
   - Click to open `/admin`

2. **Register New User**
   - Fill in email and password (min 8 chars)
   - Click "Create User"
   - User added to system (non-admin by default)
   - User list auto-refreshes

3. **Manage User Access**
   - Click "Manage Access" for any user
   - Modal opens with user email
   - Enter mailbox ID and select role
   - Click "Grant Access" or "Revoke Access"
   - Success message confirms action

### Role Hierarchy

**Owner**
- Full control of the mailbox
- Can delete mailbox
- Can manage all settings

**Admin**
- Can manage settings and users
- Can grant/revoke access
- Cannot delete mailbox

**Write**
- Can send and manage emails
- Can create folders
- Limited settings access

**Read**
- Can only view emails
- No modification permissions
- Read-only access

## 🔒 Security

1. **Admin-Only Access**
   - `/admin` route protected by `requiresAdmin` meta flag
   - Navigation guard checks `authStore.isAdmin`
   - Non-admins automatically redirected to Home

2. **Backend Validation**
   - All admin endpoints check admin status on backend
   - Returns 403 if non-admin tries to access

3. **UI Protection**
   - Admin Panel button only visible to admins
   - Direct URL access blocked by router guard

## 📸 UI Preview

### Admin Panel Layout

```
┌─────────────────────────────────────────────────────┐
│  Admin Panel                    [← Back to Home]    │
│  Manage users and mailbox access                    │
├─────────────────────────────────────────────────────┤
│  Register New User                                  │
│  ┌─────────────────┬──────────────────────┐        │
│  │ Email           │ Password             │        │
│  └─────────────────┴──────────────────────┘        │
│  [Create User]                                      │
├─────────────────────────────────────────────────────┤
│  Users                              [Refresh]       │
│  ┌───────────────────────────────────────────────┐ │
│  │ Email         │ Role  │ Created  │ Actions   │ │
│  │ admin@ex.com  │ Admin │ Dec 1    │ Manage    │ │
│  │ user@ex.com   │ User  │ Dec 2    │ Manage    │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Access Management Modal

```
┌─────────────────────────────────────────┐
│  Manage Access for user@example.com  [X]│
├─────────────────────────────────────────┤
│  Grant Mailbox Access                   │
│  ┌──────────────────┬─────────────────┐ │
│  │ Mailbox ID       │ Role            │ │
│  │ test@example.com │ [Read ▼]        │ │
│  └──────────────────┴─────────────────┘ │
│  [Grant Access]  [Revoke Access]        │
│                                          │
│  Role Descriptions:                     │
│  • Owner: Full control                  │
│  • Admin: Manage settings & users       │
│  • Write: Send and manage emails        │
│  • Read: View emails only               │
└─────────────────────────────────────────┘
```

## 🚀 Usage Examples

### 1. Create a New User

```typescript
// Admin visits /admin
// Fills form:
Email: newuser@example.com
Password: securepass123

// Clicks "Create User"
// ✅ Success: User newuser@example.com created successfully!
```

### 2. Grant Mailbox Access

```typescript
// Admin clicks "Manage Access" for newuser@example.com
// In modal, fills:
Mailbox ID: john@company.com
Role: Write

// Clicks "Grant Access"
// ✅ Success: Access granted successfully!
```

### 3. Revoke Access

```typescript
// Same modal, with mailbox ID filled
// Clicks "Revoke Access"
// Confirmation: "Revoke access to john@company.com for newuser@example.com?"
// Clicks OK
// ✅ Success: Access revoked successfully!
```

## 📝 API Request Examples

### Register User
```bash
POST /api/v1/auth/admin/register
Authorization: Bearer <admin-token>
{
  "email": "newuser@example.com",
  "password": "securepass123"
}
```

### List Users
```bash
GET /api/v1/auth/admin/users
Authorization: Bearer <admin-token>
```

### Grant Access
```bash
POST /api/v1/auth/admin/grant-access
Authorization: Bearer <admin-token>
{
  "userId": "user-uuid",
  "mailboxId": "john@company.com",
  "role": "write"
}
```

### Revoke Access
```bash
POST /api/v1/auth/admin/revoke-access
Authorization: Bearer <admin-token>
{
  "userId": "user-uuid",
  "mailboxId": "john@company.com"
}
```

## 🎨 Styling

The Admin Panel uses:
- **Tailwind CSS** for styling
- **Gradient headers** (indigo to purple)
- **Shadow and hover effects** for interactivity
- **Dark mode support** (follows system preference)
- **Responsive grid** for user cards
- **Modal overlay** for access management

## 🔧 For Developers

### Access the Admin Panel Programmatically

```typescript
// Check if user has admin access
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
if (authStore.isAdmin) {
  // Show admin features
  router.push('/admin');
}
```

### Extend with More Features

Add more admin features by:

1. **Creating new API endpoints** in `api.ts`
2. **Adding sections** to `Admin.vue`
3. **Updating backend** to handle new operations

### Example: Add "Delete User" Feature

```typescript
// In api.ts
adminDeleteUser: (userId: string) =>
  apiClient.delete(`/api/v1/auth/admin/users/${userId}`),

// In Admin.vue
async function handleDeleteUser(userId: string) {
  if (!confirm('Delete this user?')) return;
  await api.adminDeleteUser(userId);
  await loadUsers();
}
```

## ✨ Features Summary

### User Management
✅ Register new users (admin-only)
✅ List all users
✅ View user roles (Admin/User)
✅ View creation dates

### Access Management
✅ Grant mailbox access to users
✅ Revoke mailbox access
✅ Role selection (Owner, Admin, Write, Read)
✅ Per-user access management modal

### UX Features
✅ Real-time success/error messages
✅ Loading states for all actions
✅ Confirmation prompts for destructive actions
✅ Auto-refresh after actions
✅ Responsive mobile design
✅ Dark mode support

### Security
✅ Admin-only route protection
✅ Backend admin validation
✅ Token-based authentication
✅ Non-admin redirect

## 🎯 What's Complete

✅ **Admin Panel UI** - Full-featured dashboard
✅ **User Registration** - Admin can create users
✅ **User Listing** - View all users
✅ **Access Management** - Grant/revoke mailbox access
✅ **Role Management** - 4-tier role system
✅ **Router Protection** - Admin-only routes
✅ **UI Integration** - Admin button in header

---

**Status**: ✅ **Admin Panel Complete & Production Ready!**

The admin panel provides all the necessary tools for managing users and mailbox access. Admins can easily create users, view the user list, and manage who has access to which mailboxes with specific roles.

# Frontend Authentication - Complete Implementation

## ✅ What Was Added

### 1. **Auth Store** (`src/stores/auth.ts`)
- Pinia store for managing authentication state
- Session management with localStorage persistence
- Functions: `register()`, `login()`, `logout()`, `checkAuth()`
- Computed properties: `isAuthenticated`, `isAdmin`, `currentUser`

### 2. **API Service Updates** (`src/services/api.ts`)
**New Endpoints:**
- `POST /api/v1/auth/register` - User registration
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/logout` - User logout
- `GET /api/v1/auth/me` - Get current user

**Interceptors:**
- **Request interceptor**: Automatically attaches Bearer token from localStorage
- **Response interceptor**: Handles 401 errors and redirects to login

### 3. **Auth Views**
**Login View** (`src/views/Login.vue`)
- Clean, modern UI with Tailwind CSS
- Email and password fields
- Error handling
- Link to registration

**Register View** (`src/views/Register.vue`)
- Registration form with email, password, and confirm password
- Password validation (min 8 characters)
- Password match validation
- Success message before redirect

### 4. **Router Guards** (`src/router/index.ts`)
**New Routes:**
- `/login` - Login page (public)
- `/register` - Registration page (public)

**Navigation Guard:**
- Checks authentication before allowing access to protected routes
- Redirects unauthenticated users to `/login`
- Redirects authenticated users away from `/login` and `/register`
- Checks session expiration
- Auth required by default for all routes except those marked `public: true`

### 5. **UI Updates** (`src/views/Home.vue`)
- User email display in header
- Admin badge for admin users
- Logout button
- Responsive layout

## 🔒 Security Features

1. **Token-based Authentication**
   - Bearer tokens automatically attached to all requests
   - Tokens stored in localStorage
   - Automatic logout on token expiration

2. **Session Expiration**
   - 30-day session expiry (backend)
   - Frontend checks expiration before navigation
   - Automatic logout when expired

3. **Protected Routes**
   - All routes require authentication by default
   - Only `/login` and `/register` are public
   - Automatic redirect to login for unauthenticated users

4. **401 Handling**
   - Axios interceptor catches all 401 responses
   - Clears local session data
   - Redirects to login page

## 🎨 User Flow

### First Visit
1. User lands on `/` → redirected to `/login`
2. No account? Click "create a new account" → `/register`
3. Register with email & password (min 8 chars)
4. First user becomes **admin** automatically (Smart Mode)
5. Redirected to Home with mailboxes

### Subsequent Visits
1. Session loaded from localStorage
2. If valid → access granted
3. If expired → redirected to login

### Logout
1. Click "Logout" button in header
2. Session cleared from backend and localStorage
3. Redirected to `/login`

## 📝 Default Behavior

**Backend (Worker):**
```typescript
// Auth is ENABLED by default
const defaultOptions = {
  auth: {
    enabled: true,  // Secure by default
    registerEnabled: undefined  // Smart mode
  }
};
```

**Frontend (Dashboard):**
- All routes protected by default
- Session persists in localStorage
- Auto-logout on 401 or expiration

## 🚀 Testing the Auth Flow

### 1. First User (Becomes Admin)
```bash
# Navigate to the app
http://localhost:8787

# You'll be redirected to /login
# Click "create a new account"
# Register with:
# - Email: admin@example.com
# - Password: password123 (min 8 chars)

# You're now logged in as admin!
```

### 2. Additional Users
- Admin can register additional users via admin endpoints (not yet in UI)
- Public registration is closed after first user (Smart Mode)

### 3. Logout and Login
```bash
# Click "Logout" in header
# Try to access / → redirected to /login
# Login with your credentials
# Access granted!
```

## 🛠️ For Developers

### Disable Auth (Testing Only)
If you need to disable auth temporarily:

```typescript
// In your worker initialization
export default EmailExplorer({
  auth: {
    enabled: false  // ⚠️ Not recommended for production
  }
});
```

### Check if User is Admin
```typescript
// In any Vue component
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
if (authStore.isAdmin) {
  // Show admin features
}
```

### Make API Calls
```typescript
// Tokens are automatically attached by axios interceptor
import api from '@/services/api';

// This will include the Bearer token
await api.listMailboxes();
```

## 📦 Files Modified/Created

### Created
- `src/stores/auth.ts` - Auth store
- `src/views/Login.vue` - Login page
- `src/views/Register.vue` - Registration page

### Modified
- `src/services/api.ts` - Added auth endpoints & interceptors
- `src/router/index.ts` - Added auth routes & guards
- `src/views/Home.vue` - Added user info & logout button

## ✨ Features Implemented

✅ User registration (first user = admin)
✅ User login with session management
✅ Token-based authentication
✅ Automatic token attachment to requests
✅ 401 error handling with auto-redirect
✅ Session persistence in localStorage
✅ Session expiration checking
✅ Protected routes with navigation guards
✅ Logout functionality
✅ User info display in UI
✅ Admin badge display
✅ Smart Mode (first user admin, then registration closes)

## 🎯 What's Next

The basic authentication is complete! You may want to add:

### Future Enhancements
- Admin dashboard for user management
- Password reset functionality
- Email verification
- 2FA support
- Rate limiting
- Remember me checkbox
- Profile settings page

---

**Status**: ✅ **Frontend Authentication Complete & Production Ready!**

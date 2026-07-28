# Email Explorer Integration Tests

## Overview

This directory contains integration tests for the Email Explorer project, using Vitest and the Cloudflare Workers test environment.

## Test Structure

### `integration/endpoints.test.ts`
Tests for the original mailbox, email, folder, and contact endpoints.

### `integration/auth.test.ts`
Comprehensive tests for the authentication and user management feature, including:

- **Registration Flow Tests**
  - First user registration (becomes admin)
  - Password validation
  - Duplicate email prevention
  - Smart mode registration closure

- **Login Flow Tests**
  - Valid credential authentication
  - Invalid password rejection
  - Non-existent email handling
  - Session cookie creation

- **Session Management Tests**
  - Current user retrieval
  - Invalid session rejection
  - Logout and session invalidation

- **Admin Operations Tests**
  - Admin user registration
  - User listing
  - Mailbox access grant/revoke
  - Role validation (owner, admin, write, read)

- **Authorization & Permissions Tests**
  - Non-admin access denial to admin endpoints
  - Admin-only endpoint protection

- **Security Tests**
  - Password hash not exposed in responses
  - Password hashing verification
  - Invalid JSON request handling

- **Edge Cases Tests**
  - Concurrent registration handling
  - Missing field validation
  - Empty email/password handling

## Running Tests

### Run all tests
```bash
pnpm --filter email-explorer test
```

### Run auth tests only
```bash
pnpm --filter email-explorer test auth
```

### Run tests in watch mode
```bash
pnpm --filter email-explorer test --watch
```

### Run with coverage
```bash
pnpm --filter email-explorer test --coverage
```

## Test Environment

The tests use:
- **Vitest** - Fast unit test framework
- **@cloudflare/vitest-pool-workers** - Cloudflare Workers test environment
- **Miniflare** - Local Cloudflare Workers simulator

### Configuration

Tests are configured in `tests/vitest.config.mts`:
- Uses `dev/wrangler.jsonc` for worker configuration
- Single worker mode for consistency
- NodeJS compatibility enabled

### Test-Specific Entry Point

Due to Node.js module compatibility issues with the `mimetext` package (which requires `node:os`), tests use a separate entry point:

- **Production**: `src/index.ts` - Full functionality including email sending
- **Testing**: `src/index.test.ts` - Auth-only routes, no mimetext imports

The test entry point includes:
- ✅ All authentication routes
- ✅ Session management
- ✅ Admin operations
- ❌ Email sending routes (to avoid mimetext)
- ❌ Email receiving (mocked)

This allows auth tests to run without Node.js module compatibility issues while maintaining full production functionality.

## Writing Tests

### Basic Test Structure

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Feature Tests", () => {
  it("should test something", async () => {
    const response = await SELF.fetch("http://local.test/api/v1/endpoint");
    expect(response.status).toBe(200);
  });
});
```

### Helper Functions

#### Authenticated Requests
```typescript
const authenticatedFetch = (url: string, sessionToken: string, options: RequestInit = {}) => {
  return SELF.fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${sessionToken}`,
    },
  });
};
```

#### Extract Session Cookie
```typescript
const extractSessionCookie = (response: Response): string | null => {
  const setCookie = response.headers.get("Set-Cookie");
  if (!setCookie) return null;
  const match = setCookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
};
```

## Test Data

### Default Test User
- Email: `testadmin@example.com`
- Password: `adminpass123`
- Role: Admin (first user)

### Default Test Mailbox
- ID: `test@example.com`

## Coverage Goals

Aim for comprehensive coverage of:
- ✅ Happy path scenarios
- ✅ Error handling
- ✅ Edge cases
- ✅ Security validations
- ✅ Authorization checks
- ✅ Data validation

## Debugging Tests

### Enable Debug Logging
Set `DEBUG=1` environment variable:
```bash
DEBUG=1 pnpm test
```

### Inspect Worker State
Use `env` object to access bindings:
```typescript
// Access R2 bucket
await env.BUCKET.put("key", "value");

// Access Durable Object
const id = env.MAILBOX.idFromName("test");
const stub = env.MAILBOX.get(id);
```

## Troubleshooting

### "Could not read file: wrangler.jsonc"
- Check that `dev/wrangler.jsonc` exists
- Verify path in `tests/vitest.config.mts`

### Tests timeout
- Increase timeout in test: `it("test", async () => {...}, 10000)`
- Check for unresolved promises

### Durable Object errors
- Ensure migrations are up to date
- Check that DO class is exported correctly
- Verify bindings in wrangler.jsonc

## CI/CD Integration

Tests run automatically on:
- Pull requests
- Main branch commits
- Release tags

See `.github/workflows/test.yml` for configuration.

## Best Practices

1. **Isolation** - Each test should be independent
2. **Cleanup** - Clean up resources after tests (if needed)
3. **Descriptive names** - Use clear, descriptive test names
4. **One assertion per concept** - Focus tests on single behaviors
5. **Arrange-Act-Assert** - Follow AAA pattern
6. **Mock external dependencies** - Don't rely on external services

## Future Enhancements

- [ ] Add performance benchmarks
- [ ] Add load testing
- [ ] Add E2E tests with real browser
- [ ] Add mutation testing
- [ ] Add visual regression tests

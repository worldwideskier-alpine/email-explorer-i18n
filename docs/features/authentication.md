# Authentication Guide

How accounts, signing in and sessions work, and what the two roles can do.

## Creating Your Account

### The first account

A new deployment has no accounts. The first person to register becomes
**root** -- the account that runs the deployment -- and registration closes
behind them. There is no other way to become root: nothing on the site hands
the role to an existing account.

1. Open your deployment's URL; you are sent to the sign-in page
2. Choose **Create a new account**
3. Enter an email address (your sign-in address) and a password of at least
   8 characters
4. Submit -- you are signed in as root

### Everybody else

Every other account is made by root, on `/root`. Someone who tries to register
after the first account sees "Registration is closed" and should ask whoever
runs the deployment.

## Roles

There are two, different in kind rather than in degree.

- **Root** runs the deployment: makes and deletes accounts, sets passwords,
  and sees the nightly maintenance record. Root holds no mailbox and reads no
  mail; its screen does not list anyone's mailboxes.
- **Administrator** is one of the people using it: registers the addresses
  they use, reads and sends their own mail, and sees nothing of anybody
  else's. Each sets their own outbound mail key on `/admin`.

A role belongs to a **person**, not to a sign-in address. A person can sign in
through several addresses, and root keeps the role going by adding a spare
address to their own person rather than by handing it to somebody else.

See the [Admin Panel Guide](./admin-panel.md) for what each screen offers.

## Signing In

1. Open your deployment's URL
2. Enter your sign-in address and password
3. Choose **Log In**

A sign-in that fails says "Invalid credentials" whether the address or the
password was wrong, so the page does not tell a stranger which addresses
exist.

### Sessions

- A session lasts **30 days from signing in**, and then you sign in again.
- The Worker sets it as an `HttpOnly; Secure; SameSite=Strict` cookie, and
  the dashboard also keeps the same token in the browser's storage and sends
  it with each request. So a script running in the page could read it: the
  cookie flags are not the protection here. What is, is that nothing but this
  deployment's own code runs in the page -- messages are shown in a sandboxed
  frame that runs no scripts.
- Signing out ends the session on the server at once, along with the
  notification subscription that browser registered.

### Rate limiting

Repeated failed sign-ins lock an address for a while. Attempts are counted per
address and per client network (an IPv4 address, or an IPv6 /64), so a
password can be guessed at speed neither from one machine nor from many.

## Your Account (`/account`)

- **Change password.** Asks for the current one, and signs out every other
  browser you are signed in on.
- **Change sign-in address.** A confirmation link is mailed to the new
  address; nothing changes until it is opened. The link stops working if the
  password or the address changes first.
- Adding or removing a sign-in address asks for your password, because it
  outlasts the session it is done from.

## Forgotten Password

"Forgot password" on the sign-in page mails a reset link, if the deployment
has an address to send it from. See [Account Recovery](./account-recovery.md)
for how that address is set. Root can also set a password for any account on
`/root`.

A reset ends every session of that account.

## Password Requirements

At least **8 characters**. Longer is better; a password manager helps.
Passwords are hashed with PBKDF2-SHA256 at 100,000 iterations and a salt of
their own, and appear in no response.

## Troubleshooting

### "Registration is closed"

The first account already exists. Ask root to make one for you.

### Sent back to the sign-in page

The session ended: 30 days passed, you signed out elsewhere, your password
was changed or reset, or root deleted the account. Sign in again. If you were
writing something when it happened, the page stays until you move away, so
the text can be copied first.

### Keep getting signed out

Check that the browser keeps site data for your deployment; a private window
forgets it when it closes.

## Next Steps

- [Reply & Forward](./reply-forward.md)
- [Admin Panel](./admin-panel.md)
- [Rich Text Editor](./rich-text-editor.md)

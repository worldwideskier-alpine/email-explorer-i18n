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
3. Choose **Sign in**

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

Repeated failed sign-ins lock an address for a while: ten wrong passwords in
fifteen minutes lock it for fifteen. Attempts are counted per address and per
client network (an IPv4 address, or an IPv6 /64), so a password can be
guessed at speed neither from one machine nor from many.

Somebody else's wrong guesses do not lock you out, though, as long as you
sign in from a browser that has signed in to that address before: it is
counted on its own rather than with the address (its network's count still
applies), so while a stranger has the address locked, it still gets in with
the right password. It is told apart by a cookie, `login_device`, which is
sent only with the sign-in request, cannot be read by the page's scripts and
signs nothing in on its own. A browser is given one when it signs in,
registers, changes its password or finishes a password reset, and it lasts
180 days from that browser's last sign-in. That trust ends:

- when the password is changed, reset, or set by root -- for every browser
  but the one that changed or reset it;
- when the sign-in address changes, even if it is later changed back, until
  the browser signs in again;
- after 100 wrong passwords from that browser with no right one between
  them;
- for a copy of it taken from the browser, once the browser signs in again:
  every sign-in hands out a new one.

A browser that is new, or whose cookies were cleared, is counted with
everybody else and waits for the lock to end, as before. So is one that has
only stayed signed in since before this version was deployed: nothing
recorded it then, and it is given its cookie the next time it signs in,
changes its password or finishes a reset. A trusted browser that itself gets
the password wrong ten times in fifteen minutes is locked on its own, with
the same message.

One browser is trusted for one address: the last one signed in to from it.
Signing out does not end it, so on a computer somebody else will use, clear
the browser's cookies for this site when you are done.

### Bot protection (Cloudflare Turnstile)

Root can put [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
in front of the sign-in, registration and "forgot password" forms. It is off
until root sets it.

1. In the Cloudflare dashboard, open **Turnstile** and add a widget. Put your
   deployment's domain among its hostnames.
2. On `/root`, under **Bot protection for sign-in**, enter the site key and
   the secret key the widget was given.
3. The widget appears on that card and the pair is checked with Cloudflare
   at once. When it passes, choose **Check and save**.

A pair that does not pass cannot be saved: a site key from one widget with
the secret of another, a mistyped secret, or a widget that does not list
your domain (it will not appear at all). That check is what keeps a wrong
pair from refusing every sign-in, root's included.

Once it is on, each of those forms shows the widget and cannot be sent until
it has passed. A request without a passing token is refused before it counts
against the sign-in limit, so a bot cannot lock a real address out either.
If Cloudflare says the stored secret itself is not valid -- the widget was
deleted or its secret rotated -- requests are let through rather than
refused, and the Worker's log says so; set a new pair on `/root`.

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

### "The bot check did not pass"

Let the widget finish (it may ask you to tick a box) and send the form again.
If the widget does not appear at all, reload the page.

If nobody can sign in because the widget no longer lists your domain, remove
the object `settings/turnstile.json` from the deployment's R2 bucket in the
Cloudflare dashboard. That turns the check off; sign in and set it again on
`/root`.

### Keep getting signed out

Check that the browser keeps site data for your deployment; a private window
forgets it when it closes.

## Next Steps

- [Reply & Forward](./reply-forward.md)
- [Admin Panel](./admin-panel.md)
- [Rich Text Editor](./rich-text-editor.md)

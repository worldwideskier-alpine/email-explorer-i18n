# Admin and Root Screens

This fork has two management screens, and neither of them looks into anybody
else's mail.

- **`/admin`** is every administrator's own screen: the addresses they sign in
  with, and the Resend key their mail is sent through.
- **`/root`** is the screen of the person who runs the deployment: who has an
  account, and the housekeeping only the deployment's owner may do.

There is no screen that grants one person access to another person's mailbox.
A mailbox belongs to whoever created it, and that grant is the only thing that
gives access to it. See [Roles](../../README.md#roles) in the README.

## Who is who

| Role | How you get it | What it is for |
|---|---|---|
| **Root** (shown as *Owner*) | The first account ever registered on the deployment. Nothing else makes one. | Creating and deleting accounts. Root owns no mailbox and is not shown anybody's. |
| **Administrator** | An account root creates. | Their own mailboxes, their own sign-in addresses, their own sending key. |

Registration closes behind the first account. Everybody after that is created
by root, on `/root`.

## `/admin` — your own account

Open it from the **Admin Panel** link on the mailbox list. Root is sent to
`/root` instead; it has no mailboxes and sends no mail of its own.

### Addresses you sign in with

Every address listed is the same account: the same mailboxes, the same
settings. Losing one still leaves the others, which is the point of having
more than one.

- **Add another login**: an address, a password for it, and **your current
  password**. The current password is asked for because a login outlasts the
  session it was added from -- somebody who had only borrowed your session
  could otherwise add a way back in that resetting your password does not
  remove.
- **Remove**: also asks for your current password. Your last address cannot
  be removed; it is marked *Your only way in*.

### Outbound mail API key

Sending goes through [Resend](https://resend.com), with **your** key: the mail
of your mailboxes is billed to you, not to anybody else on the deployment.

- The status line says which key is in use: one set on this screen, one from
  the deployment (a `RESEND_API_KEY` Worker secret), or none -- in which case
  mail cannot be sent, and the compose screen says so.
- Saving replaces the stored key; removing it falls back to the deployment's,
  if there is one.
- The key is stored in the deployment's R2 bucket and is never shown again
  after it is saved. Anyone holding the Cloudflare account can read R2.

## `/root` — the deployment

### Accounts

The list shows each person with their sign-in addresses and role. No mailbox
and no mail is listed: what an administrator does with their own mail is not
root's business.

**Add an account** has a *Kind*:

- **Administrator** creates a new person with that address and password.
- **Owner** adds the address to root's own account: a spare way in.
  It asks for root's current password, for the same reason `/admin` does. It
  is a spare, not a second root: the role does not move, and there is no
  button that hands it to somebody else.

### Deleting a person

Deleting a person takes everything of theirs: their logins, their mailboxes,
the mail in them, the stored originals, the attachments, and every nightly
backup. Nothing brings any of it back.

So every person has a **deletion lock**, on by default. While it is on, the
delete button is not shown, and the Worker refuses the deletion even if it is
asked directly. Turning the lock off asks for confirmation; deleting asks
twice more. A mailbox somebody else also holds is left alone.

### Scheduled maintenance

One line says how the last nightly run went: backups first, then the spam
purge. A run cut off partway says where it was when it stopped -- which
mailbox, and how far into it -- because that is the only thing such a run
leaves behind.

### Leftover attachments

**Check** looks through the stored attachment files for ones no message
points at. It shows counts and sizes, never file names or contents.

- **Filed under a name that disagrees**: a message has the attachment, but it
  was stored under another name, so the message cannot open it. **Fix the
  names** moves them where the message looks.
- **Claimed by no message**: what a deletion that stopped halfway leaves --
  and also what the mail of a mailbox deleted *without* purging looks like,
  since that mail is meant to come back if the address is recreated. Nothing
  can tell the two apart from the store, so **Delete** is a separate press,
  and it cannot be undone.

## Troubleshooting

**"Registration is closed."** Somebody has already registered, and they are
root. Ask them to create your account.

**`/admin` sends me to `/root`.** You are root. Root's spare addresses are
added on `/root`.

**"No Resend API key is configured."** Set yours on `/admin`.

**The delete button is missing on `/root`.** That person's deletion lock is on.

## Related documentation

- [Authentication](authentication.md)
- [Deploying your own](../deploying-your-own.md)

# How to Reply & Forward Emails

## Overview

You can reply to emails you receive and forward them to others. Email Explorer supports:
- **Reply** - Respond to the sender only
- **Reply All** - Respond to everyone on the original email
- **Forward** - Send the email to new recipients

Replies and forwards are sent from the mailbox the original is in, through
[Resend](https://resend.com), with **your own** Resend API key -- the one you
set on `/admin` (see [Admin Panel](./admin-panel.md#outbound-mail-api-key)).
There is no deployment-wide key to fall back on: until you have set yours,
nothing can be sent, and the compose screen says so.

## How to Reply to an Email

### Step 1: Open the Email
Click on any email in your inbox or other folder to view it.

### Step 2: Click Reply
In the email detail view, you'll see three action buttons at the top:
- **Reply** - Respond only to the sender
- **Reply All** - Respond to everyone (sender + all recipients)
- **Forward** - Send to new people

Click the **Reply** button.

### Step 3: Compose Your Reply
The compose window opens with:
- **To:** Pre-filled with the sender's email address
- **Subject:** Pre-filled with "Re: [Original Subject]" -- unless the subject
  already starts with a reply prefix (`Re:`, `RE:`, `AW:`, `SV:`, `返信:` and
  others), in which case it is kept as it is rather than stacking another one
- **Message:** The original email quoted below, under a line saying "On
  [date], [sender] wrote:"
- Your signature, above the quote, if the mailbox has one turned on

Type your response above the quoted text.

A reply to a message in the **spam** folder quotes its words only, without
pictures or formatting: the editor is part of the page rather than the
sandboxed frame messages are read in, so a quoted picture would be fetched
from the sender the moment the reply opened.

### Step 4: Send
Click **Send Message**. Your reply is sent and a copy is saved to the
mailbox's Sent folder.

## How to Reply All

Use **Reply All** when you want to include everyone from the original email in your response.

### When to Use Reply All
- Group discussions
- Team emails where everyone needs to stay in the loop
- When the sender included multiple people for a reason

### When NOT to Use Reply All
- Personal responses that don't concern others
- When you only need to answer the sender
- Large distribution lists (to avoid spam)

### Steps
1. Open the email
2. Click **Reply All** instead of Reply
3. The compose window opens with the sender and the original "To" recipients
   in "To", and the original "Cc" recipients in "Cc" -- each address once, and
   without this mailbox's own address
4. Type your message
5. Click **Send Message**

## How to Forward an Email

Forwarding lets you send someone else's email to a new recipient.

### Step 1: Open the Email
Click on the email you want to forward.

### Step 2: Click Forward
Click the **Forward** button at the top of the email.

### Step 3: Add Recipients
The compose window opens with:
- **To:** Empty (you need to fill this in)
- **Subject:** Pre-filled with "Fwd: [Original Subject]", unless it already
  starts with a forward prefix (`Fwd:`, `FW:`, `WG:`, `TR:` and others)
- **Message:** The original email content in a box headed "Forwarded
  message:", with its sender, date and subject

Enter the email address(es) of who should receive the forwarded email.

### Step 4: Add Context (Optional)
You can add your own message above the forwarded content to provide context:
```
Hi Alex,

You might find this interesting!

Forwarded message:
From: sender@example.net
Date: ...
Subject: ...
[Original email content]
```

### Step 5: Send
Click **Send Message**. The forwarded email is sent to your recipients and a
copy is saved in the mailbox's Sent folder.

## Rich Text Editing

The compose window includes a rich text editor that lets you:
- **Bold**, *italic*, and underline text
- Create bulleted and numbered lists
- Add links
- Format text with different styles
- Paste formatted content from other applications

### Tips for Rich Text
- Use the toolbar buttons to format your text
- The editor preserves formatting when replying to HTML emails, tables
  included
- Both HTML and plain text versions are sent automatically
- **Send as plain text** sends the message as text only

**Learn More**: See the [Rich Text Editor Guide](./rich-text-editor.md) for detailed formatting instructions.

## Email Threading

A reply names the message it answers in the headers other mail clients thread
by:

- **In-Reply-To** carries the original's own **Message-ID** -- the one its
  sender gave it, kept when the message arrived.
- **References** carries the original's References plus that Message-ID, so
  the whole chain goes along.

Email clients that thread by these headers show your reply grouped with the
original.

Mail sent from Email Explorer has no Message-ID that it knows: Resend assigns
one and does not say what it was. A reply to one of your own sent messages
therefore carries no In-Reply-To, and keeps the thread through References.

A forward carries no threading headers at all: it starts a new conversation.

Email Explorer itself shows messages one by one; there is no conversation
view that groups them.

## Attachments in Replies

You can add attachments to your replies and forwards:

1. Compose your reply or forward as normal
2. Under **Attachments**, choose the files
3. The attachments will be included when you send

The total may be up to **20 MB**; above that, the compose window refuses to
send and says so.

**Note:** When forwarding, the original email's attachments are NOT automatically included. You need to manually add them if desired.

Pictures that appear *inside* the quoted message are the exception: they
show in the editor, and go with the reply or forward as pictures in its
body (and count towards the 20 MB). Delete one from the quote and it is not
sent. If one cannot be fetched when you press Send, the message is not sent
and the window says so, rather than going out with a broken picture.

**Note:** A saved draft does not keep attachments. Add them again before
sending a draft. Pictures in a quote are kept, since they are part of the
text.

## Drafts

**Save Draft** keeps a reply or forward to finish later. A reply saved as a
draft remembers which message it answers, so sending it later is still a
reply, with the threading headers above. Drafts are saved only when you press
the button, not automatically.

## Keyboard Shortcuts

There are none for Reply, Reply All or Forward. The editor's own formatting
shortcuts (such as bold and italic) work while you type.

## Frequently Asked Questions

### Can I edit the quoted text when replying?
Yes! The quoted text is editable. You can trim it, add comments inline, or remove parts that aren't relevant.

### What happens if I reply to a forwarded email?
Your reply will be threaded with the forwarded email, not the original conversation. Forwarding breaks the thread chain.

### Can I see all emails in a conversation thread?
No. Emails are shown individually.

### Does the recipient see that it's a reply?
Yes, the email subject includes "Re:" and the email headers contain threading information that most email clients recognize.

### Can I reply to multiple recipients individually?
No. You'd need to compose separate new emails to each person.

### Why does my reply quote the original message?
This is standard email etiquette. It provides context for your response and helps recipients remember what was discussed.

### Can I turn off automatic quoting?
No, but you can delete the quoted text before sending if you don't want it.

### What if I accidentally click Reply instead of Reply All?
Just close the compose window and click Reply All instead. Nothing is sent until you click Send Message.

### Which key is my reply sent with?
Yours: the Resend key you set on `/admin`. A mailbox's mail is sent with the
key of the person who holds it, never with somebody else's.

## Troubleshooting

### "No Resend API key is configured."
You have not set your own Resend key. Set it on `/admin`; there is no shared
key to fall back on.

### The Reply button doesn't work
- Make sure you're viewing an email (not in the list view)
- Refresh the page and try again
- Check browser console for errors

### Recipients aren't pre-filled correctly
- This may happen with malformed email addresses
- You can manually type or correct the recipients

### My formatting disappears
- Ensure **Send as plain text** is off
- Some email clients may not support all HTML formatting

### The quoted text looks wrong
- The system attempts to format quotes properly
- You can manually edit the quoted text before sending

## Best Practices

### Reply Etiquette

**Do:**
- ✓ Respond promptly to emails
- ✓ Keep the original message for context
- ✓ Use Reply All when others need to know
- ✓ Trim unnecessary quoted text in long threads
- ✓ Add your response at the top (above the quote)

**Don't:**
- ✗ Reply All to large groups unnecessarily
- ✗ Delete important context from quotes
- ✗ Send empty replies (always add your response)

### Forward Etiquette

**Do:**
- ✓ Add context explaining why you're forwarding
- ✓ Check if the original sender wants their message shared
- ✓ Remove sensitive information if necessary
- ✓ Add your own introduction

**Don't:**
- ✗ Forward without permission if content is sensitive
- ✗ Forward spam or chain letters
- ✗ Send massive email threads without summarizing

### Professional Communication

1. **Clear Subject Lines**: Keep "Re:" and "Fwd:" prefixes, so readers see what a message answers
2. **Proper Salutations**: Start with a greeting appropriate for your recipient
3. **Concise Responses**: Get to the point quickly
4. **Professional Tone**: Match the formality of the original email
5. **Proofread**: Check for typos before sending

## Use Cases

### Reply for Simple Questions
```
From: colleague@example.com
Subject: Meeting time?

Hi, what time is our meeting tomorrow?

---Your Reply---
Subject: Re: Meeting time?

Hi,

Our meeting is at 2 PM tomorrow in Conference Room B.

Best regards
```

### Reply All for Team Updates
```
From: manager@example.com
To: team@example.com
Subject: Project deadline moved

The deadline has been moved to next Friday.

---Your Reply All---
Subject: Re: Project deadline moved

Thanks for the update!

I'll adjust my schedule accordingly.
```

### Forward with Context
```
---Your Forward---
To: colleague@example.com
Subject: Fwd: Important client feedback

Hi Alex,

See below for the client's feedback on the proposal.
Can you address their concerns by Thursday?

Forwarded message:
From: client@example.net
Subject: Proposal feedback
...
```

## Not Available Yet

These do not exist today:
- **Conversation View** - See all emails in a thread grouped together
- **Quick Reply** - Reply directly from the email list
- **Template Responses** - Save common replies
- **Scheduled Sending** - Schedule replies to send later
- **Keyboard shortcuts** for Reply, Reply All and Forward

## Related Features

- **[Rich Text Editor](./rich-text-editor.md)** - Learn how to format your replies with bold, colors, and more
- **[Authentication](./authentication.md)** - Managing your email account
- **[Admin Panel](./admin-panel.md)** - Your own sending key, on `/admin`

## Need Help?

If you encounter issues with reply or forward functionality:
1. Check this guide first
2. Try refreshing the page
3. Check that your own Resend key is set on `/admin`
4. Ask whoever runs your deployment (root) if problems persist
5. Report bugs on GitHub

---

**Ready to start replying?** Open any email and click Reply to get started!

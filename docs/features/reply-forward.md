# How to Reply & Forward Emails

## Overview

You can now reply to emails you receive and forward them to others. Email Explorer supports:
- **Reply** - Respond to the sender only
- **Reply All** - Respond to everyone on the original email
- **Forward** - Send the email to new recipients

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
- **Subject:** Pre-filled with "Re: [Original Subject]"
- **Message:** The original email is quoted below with a "> " prefix

Type your response above the quoted text.

### Step 4: Send
Click the **Send** button. Your reply will be sent and saved to your Sent folder.

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
3. The compose window opens with all original recipients in the "To" field
4. Type your message
5. Click **Send**

## How to Forward an Email

Forwarding lets you send someone else's email to a new recipient.

### Step 1: Open the Email
Click on the email you want to forward.

### Step 2: Click Forward
Click the **Forward** button at the top of the email.

### Step 3: Add Recipients
The compose window opens with:
- **To:** Empty (you need to fill this in)
- **Subject:** Pre-filled with "Fwd: [Original Subject]"
- **Message:** The original email content with a "Forwarded message" header

Enter the email address(es) of who should receive the forwarded email.

### Step 4: Add Context (Optional)
You can add your own message above the forwarded content to provide context:
```
Hi John,

You might find this interesting!

---------- Forwarded message ----------
[Original email content]
```

### Step 5: Send
Click **Send**. The forwarded email will be sent to your recipients and saved in your Sent folder.

## Rich Text Editing

The compose window now includes a rich text editor that lets you:
- **Bold**, *italic*, and underline text
- Create bulleted and numbered lists
- Add links
- Format text with different styles
- Paste formatted content from other applications

### Tips for Rich Text
- Use the toolbar buttons to format your text
- The editor preserves formatting when replying to HTML emails
- Both HTML and plain text versions are sent automatically

**Learn More**: See the [Rich Text Editor Guide](./rich-text-editor.md) for detailed formatting instructions.

## Email Threading

When you reply to an email, Email Explorer automatically:
- Links your reply to the original message
- Maintains the conversation thread
- Groups related emails together (coming soon: conversation view)

This means:
- Email clients that support threading will show your reply grouped with the original
- You can track conversation history
- Replies stay organized

## Attachments in Replies

You can add attachments to your replies and forwards:

1. Compose your reply or forward as normal
2. Click the attachment button (if available in the composer)
3. Select files to attach
4. The attachments will be included when you send

**Note:** When forwarding, the original email's attachments are NOT automatically included. You need to manually add them if desired.

## Keyboard Shortcuts (Coming Soon)

Future versions will support:
- `R` - Reply
- `A` - Reply All  
- `F` - Forward
- `Esc` - Close compose window

## Frequently Asked Questions

### Can I edit the quoted text when replying?
Yes! The quoted text is editable. You can trim it, add comments inline, or remove parts that aren't relevant.

### What happens if I reply to a forwarded email?
Your reply will be threaded with the forwarded email, not the original conversation. Forwarding breaks the thread chain.

### Can I see all emails in a conversation thread?
Currently, emails are shown individually. A conversation/thread view is planned for a future update.

### Does the recipient see that it's a reply?
Yes, the email subject includes "Re:" and the email headers contain threading information that most email clients recognize.

### Can I reply to multiple recipients individually?
Not yet. You'd need to compose separate new emails to each person. A "Reply Separately" feature may be added in the future.

### Why does my reply quote the original message?
This is standard email etiquette. It provides context for your response and helps recipients remember what was discussed.

### Can I turn off automatic quoting?
Not currently, but you can manually delete the quoted text before sending if you don't want it.

### What if I accidentally click Reply instead of Reply All?
Just close the compose window and click Reply All instead. Nothing is sent until you click Send.

## Troubleshooting

### The Reply button doesn't work
- Make sure you're viewing an email (not in the list view)
- Refresh the page and try again
- Check browser console for errors

### Recipients aren't pre-filled correctly
- This may happen with malformed email addresses
- You can manually type or correct the recipients

### My formatting disappears
- Ensure you're using the rich text editor, not plain text
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
- ✗ Change the subject line (breaks threading)

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

1. **Clear Subject Lines**: Keep "Re:" and "Fwd:" prefixes for threading
2. **Proper Salutations**: Start with a greeting appropriate for your recipient
3. **Concise Responses**: Get to the point quickly
4. **Professional Tone**: Match the formality of the original email
5. **Proofread**: Check for typos before sending

## Use Cases

### Reply for Simple Questions
```
From: colleague@company.com
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
From: manager@company.com
To: team@company.com
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
To: colleague@company.com
Subject: Fwd: Important client feedback

Hi John,

See below for the client's feedback on the proposal.
Can you address their concerns by Thursday?

---------- Forwarded message ----------
From: client@external.com
Subject: Proposal feedback
...
```

## Future Enhancements

Planned improvements include:
- **Conversation View** - See all emails in a thread grouped together
- **Draft Support** - Save reply/forward as draft
- **Quick Reply** - Reply directly from the email list
- **Smart Quoting** - Better formatting of quoted content
- **Template Responses** - Save common replies
- **Inline Images** - Better handling of images in replies
- **Scheduled Sending** - Schedule replies to send later

## Related Features

- **[Rich Text Editor](./rich-text-editor.md)** - Learn how to format your replies with bold, colors, and more
- **[Authentication](./authentication.md)** - Managing your email account
- **[Admin Panel](./admin-panel.md)** - For administrators managing user access

## Need Help?

If you encounter issues with reply or forward functionality:
1. Check this guide first
2. Try refreshing the page
3. Check your mailbox permissions
4. Contact your administrator if problems persist
5. Report bugs on GitHub

---

**Ready to start replying?** Open any email and click Reply to get started!

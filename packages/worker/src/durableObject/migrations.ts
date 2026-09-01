import type { Migration } from "workers-qb";

import { LEGACY_ADMIN_PERSON_ID } from "../people";

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: `
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT NOT NULL UNIQUE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `,
	},
	{
		name: "2_add_email_threading",
		sql: `
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;
            
            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `,
	},
	{
		name: "3_add_draft_folder",
		sql: `
            INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Draft', 0);
        `,
	},
	{
		// recipient, cc and bcc all hold a comma-separated address list, the
		// form the To:/Cc: headers already use. Existing rows carry a single
		// address, which is a valid list of one, so nothing needs migrating.
		//
		// bcc is stored on sent mail so the sender can see whom they blind
		// copied. It never reaches a recipient: Resend keeps it out of the
		// headers, and inbound mail has no bcc to record.
		name: "4_add_cc_bcc",
		sql: `
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `,
	},
	{
		/**
		 * Whether the second-stage spam check is actually working.
		 *
		 * It fails open: a rejected key, a timeout, anything at all, and the
		 * message goes to the inbox with a line in the Worker log nobody
		 * reads. The settings screen meanwhile went on showing the key as
		 * configured, so a filter that had stopped running looked exactly like
		 * one finding nothing to catch.
		 *
		 * One row, held to one row by the CHECK. Kept here rather than in the
		 * mailbox's R2 settings object because this is written on every
		 * incoming message: the Durable Object serialises those writes, while
		 * a read-modify-write against R2 would race two arrivals against each
		 * other and could lose the API key or the sender rules stored beside
		 * it.
		 */
		name: "5_spam_check_health",
		sql: `
            CREATE TABLE spam_check_health (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_success_at TEXT,
                last_failure_at TEXT,
                last_failure_reason TEXT
            );

            INSERT INTO spam_check_health (id) VALUES (1);
        `,
	},
	{
		// A reason code says the reply could not be read; it cannot say what
		// the reply was. Without that, an unreadable reply is unfixable: it is
		// gone by the time anyone looks, and a Worker keeps no logs.
		name: "6_spam_check_failure_detail",
		sql: `
            ALTER TABLE spam_check_health ADD COLUMN last_failure_detail TEXT;
        `,
	},
];

export const authMigrations: Migration[] = [
	{
		name: "1_auth_setup",
		sql: `
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE user_mailboxes (
                user_id TEXT NOT NULL,
                mailbox_id TEXT NOT NULL,
                role TEXT NOT NULL,
                PRIMARY KEY (user_id, mailbox_id)
            );

            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
            CREATE INDEX idx_user_mailboxes_user_id ON user_mailboxes(user_id);
            CREATE INDEX idx_user_mailboxes_mailbox_id ON user_mailboxes(mailbox_id);
        `,
	},
	{
		name: "2_add_push_subscriptions",
		sql: `
            CREATE TABLE push_subscriptions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX idx_push_subscriptions_user_id ON push_subscriptions(user_id);
        `,
	},
	{
		name: "3_add_auth_throttle",
		sql: `
            CREATE TABLE auth_throttle (
                bucket TEXT PRIMARY KEY,
                failures INTEGER NOT NULL,
                window_started_at INTEGER NOT NULL,
                locked_until INTEGER
            );

            CREATE INDEX idx_auth_throttle_window ON auth_throttle(window_started_at);
        `,
	},
	{
		/**
		 * Which account holds the root role.
		 *
		 * Here rather than in a deployment variable because this is software
		 * people fork and deploy: saying who administers their own mail must
		 * not require going to GitHub. A single row, so there is exactly one
		 * root or none at all.
		 */
		name: "4_root_account",
		sql: `
            CREATE TABLE app_roles (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                root_user_id TEXT
            );

            INSERT INTO app_roles (id) VALUES (1);
        `,
	},
	{
		/**
		 * The person a login belongs to.
		 *
		 * A row in `users` is a login, not a person. One person holds several
		 * of them -- a second address to sign in with, so that losing the
		 * first does not lock them out -- and they are equal: none is the
		 * original, the second was simply added later. What ties them
		 * together had nowhere to live until this column, so it did not exist
		 * at all, and the deployment made up for the gap with a flag: an
		 * account carrying `is_admin` saw every mailbox there was. That reads
		 * as one person's own estate only while the deployment holds one
		 * person, and fails the moment it holds two, because nothing in the
		 * stored data can tell them apart.
		 *
		 * The backfill:
		 *
		 *  - **Everyone who is an administrator today becomes one person.** In
		 *    a deployment used by one person with a spare login that is
		 *    exactly right, and it is the only rule that leaves what they can
		 *    see unchanged: the flag already treated them as one.
		 *  - Everybody else gets a person of their own.
		 *
		 * The first line is a migration, not a policy. It describes a
		 * deployment whose administrators are one person with several logins,
		 * which is the shape this fork is in and the shape the flag
		 * encouraged. A deployment where two different people had both been
		 * made administrators would be merged by it, and nothing stored can
		 * distinguish the two cases -- the link never existed to be read.
		 * Anyone in that position has to separate them afterwards.
		 */
		name: "5_people",
		sql: `
            ALTER TABLE users ADD COLUMN person_id TEXT;

            UPDATE users SET person_id = '${LEGACY_ADMIN_PERSON_ID}' WHERE is_admin = 1;
            UPDATE users SET person_id = 'person-' || id WHERE person_id IS NULL;

            CREATE INDEX idx_users_person_id ON users(person_id);
        `,
	},
	{
		/**
		 * Everything that was held against a login moves to the person.
		 *
		 * Two things were: which account is root, and which mailboxes an
		 * account may reach. Both belong to the person, for the same reason.
		 *
		 * **Root.** Held as a login id, the role dies with that login. The
		 * person holding it would have to be handed the role again by
		 * somebody -- and the only somebody is themselves, so the escape was
		 * a "transfer" button that could point at anyone. On software sold to
		 * customers that button is a way to hand a customer the whole
		 * deployment, and no seller wants one. Held against the person, the
		 * role survives losing a login, because the person keeps their other
		 * ones. Succession stops being a transfer and becomes the same spare
		 * login everybody else has.
		 *
		 * **Mailboxes.** A grant against a login means deleting that login
		 * takes its mailboxes' only claim with it, while the person's other
		 * logins go on existing and seeing nothing. Held against the person,
		 * a login can come and go and the mail stays reachable.
		 *
		 * The grant table is rebuilt rather than altered: its primary key is
		 * (user_id, mailbox_id), and two logins of one person collapse onto
		 * the same row once the person is the key. INSERT OR IGNORE on the
		 * copy is what merges them.
		 */
		name: "6_people_own",
		sql: `
            ALTER TABLE app_roles ADD COLUMN root_person_id TEXT;

            UPDATE app_roles
               SET root_person_id = (
                     SELECT person_id FROM users WHERE users.id = app_roles.root_user_id
                   )
             WHERE root_user_id IS NOT NULL;

            CREATE TABLE person_mailboxes (
                person_id TEXT NOT NULL,
                mailbox_id TEXT NOT NULL,
                PRIMARY KEY (person_id, mailbox_id)
            );

            INSERT OR IGNORE INTO person_mailboxes (person_id, mailbox_id)
                 SELECT u.person_id, um.mailbox_id
                   FROM user_mailboxes um
                   JOIN users u ON u.id = um.user_id
                  WHERE u.person_id IS NOT NULL;

            DROP TABLE user_mailboxes;

            CREATE INDEX idx_person_mailboxes_mailbox_id ON person_mailboxes(mailbox_id);
        `,
	},
];

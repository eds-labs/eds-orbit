# E-mail and member notifications

Orbit reaches e-mail through the project's own existing mailbox: SMTP to send, IMAP to receive (WP4.7). Mario decided this on 2026-10-17 (Q-16). No new e-mail provider is added, and Orbit makes no DNS change. SPF, DKIM and DMARC are the mailbox provider's, so Orbit sends only as the mailbox's own address.

Two flags, both `false` by default:

| Flag                  | Turns on                                                            |
| --------------------- | ------------------------------------------------------------------- |
| `ORBIT_EMAIL`         | the mailbox connection, sending, receiving and e-mail notifications |
| `ORBIT_NOTIFICATIONS` | in-app member notifications (the bell) and their preferences        |

Real delivery additionally needs `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`. Otherwise every message ends as a `test_receipt`: recorded, delivered nowhere.

## Connecting the mailbox (owner)

Connectors → E-mail mailbox → Configure:

- the address and sender name;
- the user name and password;
- the SMTP server, port and TLS mode (implicit or STARTTLS);
- the IMAP server, port and TLS mode.

The password is encrypted like every credential and never shown again. "Check login" logs in to SMTP and IMAP and sends nothing; the connection is then `read_verified`. A real test message is a separate step that needs approval.

Hosts must be public DNS names that resolve to public addresses only. IP literals and local names are refused. SMTP and IMAP connect to the address that was checked, with no second lookup. TLS verifies the certificate against the host name.

## Sending

- **Queueing.** Modules call `queueEmail` inside their transaction. The `email_send` job sends through the newest verified connection. Each message is one `email_messages` row with an Orbit Message-ID (`<orbit.<id>@<domain>>`).
- **Outcomes:**

  | State              | Meaning                                                                                                                                                                                                    |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `sent`             | the server accepted it                                                                                                                                                                                     |
  | `rejected`         | 5xx; not retried                                                                                                                                                                                           |
  | `retry` → `failed` | nothing was handed over; at most three attempts                                                                                                                                                            |
  | `outcome_unknown`  | the connection broke or timed out after the envelope was under way, with no server reply; or the job was interrupted while sending. Never sent again; the owner gets the exception `EMAIL_OUTCOME_UNKNOWN` |
  | `test_receipt`     | outside live mode                                                                                                                                                                                          |

- **Steps.** Orbit runs the SMTP session itself (connect, log in, hand over), because nodemailer reports a lost connection the same way before and after the message is out.
- **Automatic mail.** Notifications carry `Auto-Submitted: auto-generated`. Subjects, In-Reply-To and References are single lines (no header injection). A reply to an automatic inbound message is refused (`EMAIL_REPLY_TO_AUTOMATIC`, RFC 3834), so two auto-responders cannot mail each other forever.
- **While paused.** A paused project sends nothing. A message whose job the pause blocks is recorded as `skipped` (`PROJECT_PAUSED`) and is not sent later.

## Receiving

- **Fetching.** Every two minutes per project with a verified connection, new INBOX messages are fetched read-only: nothing is flagged, moved or deleted. At most 25 per pass, 10 MB each; larger ones are skipped and counted. A new UIDVALIDITY starts over; the Message-ID check keeps it free of duplicates.
- **Storage.** Each message is kept twice:
  - the raw MIME as an encrypted platform file (`docs/PLATFORM_FILES.md`), so receiving needs platform files;
  - a normalized `inbound_emails` row: sender, recipients, subject, date, text (20,000 characters), threading headers, attachment count and the file id. Every field is bounded and free of control characters.
- **Unreadable mail.** A message the parser refuses (too deeply nested, oversized headers) is kept as an `unreadable` row with its raw file. A single message never stops the mailbox from being read.
- **Automatic mail.** Auto-replies, lists, bulk mail and mailer daemons are flagged `automatic`. Modules must not answer them.
- **Bounces.** A bounce is a failed-delivery report: an RFC 3464 report with `Action: failed`, or a classic mailer-daemon bounce. When it names an Orbit Message-ID of this project and one of that message's recipients, it marks the message `bounced` and is not handed to modules. Read receipts, "delayed" warnings and replies are not bounces. A recipient can still forge a bounce for their own copy; that cannot be checked over IMAP. Complaints (spam reports) do not exist over SMTP/IMAP; that is a known limit of this choice.
- **Orbit's own mail.** A copy of an Orbit message that comes back into the INBOX is stored with `ownMessage: true` and is not handed to modules.
- **Hand-over.** Modules that registered `emailInbound: { queueClass }` get one job per message, if they are on in the project. Mail content is untrusted data.

## Member notifications

- **Kinds.** A module registers its kinds (`userNotifications`) and calls `notifyMembers` in its transaction.
- **Who gets one.** Members of the project get an in-app notice unless they muted the kind. Non-members and members with no access to the module (module role `none`) get nothing.
- **E-mail.** Sent only when the member chose it for that kind (or the kind's default says so) and `ORBIT_EMAIL` is on. It goes to the member's account address through the project's mailbox.
- **Privacy.** Notices and preferences are private to each member by row-level security (the chat tables' policy).
- **Links.** A link is an Orbit path: a leading `/`, no second `/` or `\` after it, and no backslash, whitespace or control character anywhere. Browsers read `/\x` and `/<tab>/x` as `//x`, another site. The API, the database check and the bell apply the same rule.
- **Bell.** It shows the unread count (polled every minute), a list with mark-as-read and settings per kind. Links are followed only within Orbit.

## Dependencies

All three are pinned exactly and were at least two weeks old when added:

| Package       | Version | License | Used for                      |
| ------------- | ------- | ------- | ----------------------------- |
| `nodemailer`  | 10.0.13 | MIT-0   | SMTP                          |
| `imapflow`    | 2.2.1   | MIT     | IMAP                          |
| `postal-mime` | 4.0.2   | MIT-0   | MIME parsing, no dependencies |

They are part of the merge approval. Object storage (WP4.6) needs no dependency. On 2026-10-17 no advisory affected these versions; newer releases add hardening, see `docs/SECURITY_REVIEW.md` (WP4.7).

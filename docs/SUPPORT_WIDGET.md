# Support widget: integration guide for app teams

This guide is for apps such as uLiquid Desk that embed Orbit's support chat (WP5.4). For the Desk pilot, Claude does the Desk side (decision Q-20). That work has its own PR in the Desk repository, and deploying it needs Mario's approval.

## What Orbit provides

- **The script** `https://<orbit-web>/widget/v1.js`: about 6 KB gzip, no dependencies, in a Shadow DOM, DE/EN, keyboard accessible.
- **A widget key** per inbox (`pk_…`), created by the project owner. It allows the inbox's origins only, and a new key revokes the old one.
- **A widget secret** per inbox, shown once to the owner. It signs user ids. **Mario stores it in the app's backend himself; no agent ever handles it.**

## Embed

In Orbit: Settings, then Support, then "Widget embed" on the inbox. Copy the snippet:

```html
<script>window.OrbitSupportConfig = {"key":"pk_…","locale":"de"};</script>
<script src="https://<orbit-web>/widget/v1.js" async></script>
```

Optional config:

| Option | Meaning |
|---|---|
| `color` | The brand colour of the launcher and header |
| `title` | The panel title |
| `user` | Signed-in users; see below |

**Content Security Policy** of the app:
- allow `script-src https://<orbit-web>`;
- allow `connect-src https://<orbit-web>`.

**If Orbit is unreachable**, the widget shows nothing and the app keeps working (master spec H05).

## Signed-in users (verified identity)

The app's **backend** signs the user id. Desk never calls Orbit's server; it only signs.

```ts
import { createHmac } from "node:crypto";
// widgetSecret: from the app's secret store (set by Mario), never sent to the browser.
const signature = createHmac("sha256", widgetSecret).update(String(user.id)).digest("hex");
// Rendered into the page for the signed-in user:
window.OrbitSupportConfig = {
  key: "pk_…",
  locale: "de",
  user: { id: String(user.id), signature, email: user.email, name: user.displayName },
};
```

- A valid signature links the chat to that user across sessions and devices, so their history shows.
- The e-mail passed alongside is a **claim**. It is never used to merge with other contacts.
- An invalid signature is refused (`SIGNATURE_INVALID`) and audited.

**Anonymous visitors** give an e-mail and see only the conversations of their browser session.

## Behaviour

- **Delivery.** Messages appear live: a stream with resume, falling back to 5-second polling.
- **Offline.** When the visitor is offline, agent replies are also mailed to their address, while the project's mailbox is connected (WP5.3).
- **Talk to a human.** This hands the ticket to the team.
- **Limits.** 20 new sessions per minute per IP and key; 120 calls per minute per session; JSON bodies up to 64 KB.
- **Attachments.** Widget messages are text only in the MVP; the public API takes JSON only.

## Desk pilot checklist (Q-20)

1. In Orbit, Mario creates the inbox "uLiquid Desk" (widget plus e-mail, origin `https://desk.uliquid.vip`) and copies the widget secret into Desk's secret store.
2. Mario creates the widget embed key.
3. Claude opens a PR in the Desk repository that:
   - loads the snippet on signed-in pages;
   - computes the signature in Desk's backend;
   - adds the CSP entries.
4. Mario approves the Desk deploy, after the Orbit pilot rollout (WP5.9).

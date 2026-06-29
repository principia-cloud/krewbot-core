# Integration Setup Guide

This guide walks the admin through connecting third-party services to a workspace from the operator's web dashboard. The dashboard URL is the agent's `APP_URL` (already in your system prompt as `{{app_url}}`); always send the admin that exact URL when telling them where to click.

All integrations live in the same place in the dashboard. Point the user at the right card, then walk them through the fields.

## How to reach the integrations panel

Every integration setup starts with the same three clicks:

1. Open the dashboard URL and sign in.
2. Pick the target workspace from the workspace switcher at the top of the left sidebar (click the workspace name to expand the switcher, then select the workspace).
3. Click **Integrations** (puzzle-piece icon) in the left sidebar.

**Note:** If the current turn arrived on the **HTTP channel**, the admin is already signed in to the dashboard in the workspace they're messaging from — skip steps 1 and 2 and just tell them to click **Integrations** in the left sidebar. Only send the full "open the dashboard and sign in" walkthrough when the request comes in on a non-HTTP channel (Telegram, Slack, WhatsApp, Teams).

You'll land on the Integrations page. Each service has a card. Click **Connect** on a card to open its setup dialog, fill in the required fields, and click **Save**. A successfully connected card shows a green **Connected** badge and the button becomes **Disconnect**.

The rest of this guide tells the admin *which* card to click and *what* to put in the fields.

---

## AI Model

### Claude (required for agent operation)

Claude is the model that powers the agent. Without a Claude token the agent cannot run.

To set up Claude, click **Integrations > Claude > Connect**, then:

1. Go to the Anthropic console and copy your Claude API key.
2. Paste it into the **API Token** field in the dialog.
3. Click **Save**.

---

## Messaging Platforms

The agent can talk to your team on any of the channels below. You can enable several at once; the admin usually starts with Telegram.

After you connect a new channel for the first time, the agent will send a brief greeting on that channel so you know it's live.

### Telegram

To set up Telegram, click **Integrations > Telegram > Connect**, then:

1. On Telegram, open a chat with **@BotFather** and send `/newbot`. Follow the prompts to pick a bot name and username.
2. BotFather will reply with an API token that looks like `123456789:ABCdefGHI...`. Copy it.
3. Paste it into the **Bot Token** field in the dialog.
4. Find your Telegram User ID (forward any message to **@userinfobot** on Telegram to see your numeric ID). Paste it into the **Admin User ID** field.
5. Click **Save**.

### Slack

To set up Slack, click **Integrations > Slack > Connect**, then:

1. Go to **https://api.slack.com/apps** and create a new Slack app for your workspace.
2. Install the app to your workspace, then open **OAuth & Permissions** and copy the **Bot User OAuth Token** (it starts with `xoxb-`). Paste it into the **Bot Token** field.
3. Open **Basic Information** and copy the **Signing Secret**. Paste it into the **Signing Secret** field.
4. Click **Save**.

### WhatsApp

To set up WhatsApp, click **Integrations > WhatsApp > Connect**, then:

1. In **Meta Business Suite**, set up a WhatsApp Business account and create a WhatsApp app.
2. From your app dashboard, generate a **permanent API token** and paste it into the **Business API Token** field.
3. Open **WhatsApp > Getting Started** in the app dashboard, copy the **Phone Number ID**, and paste it into the **Phone Number ID** field.
4. Click **Save**.

### Microsoft Teams

To set up Microsoft Teams, click **Integrations > Microsoft Teams > Connect**, then:

1. In the Azure portal, register a new bot via the **Azure Bot Framework**.
2. Copy the **Microsoft App ID** from the bot registration and paste it into the **App ID** field.
3. Generate a client secret (App Password) for the bot and paste it into the **App Password** field.
4. Click **Save**.

---

## Productivity

### Notion

To set up Notion, click **Integrations > Notion > Connect**, then:

1. Go to **https://www.notion.so/my-integrations** and click **New integration**. Give it a name (any name works) and associate it with your workspace.
2. Copy the **Internal Integration Token** (it starts with `ntn_`) and paste it into the **Integration Token** field in the dashboard dialog.
3. Click **Save**.
4. In Notion, open each page or database you want the agent to access, click **Share > Add connections**, and add your integration. The agent can only see pages that have been explicitly shared with the integration.

### Google

To set up Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms), click **Integrations > Google > Connect**, then:

1. Paste your Google account token into the **Account Token** field.
2. Click **Save**.

### GitHub *(coming soon)*

GitHub integration is visible on the page but not yet available. The card is disabled until the integration ships.

### Linear *(coming soon)*

Linear integration is visible on the page but not yet available. The card is disabled until the integration ships.

---

## Managing an existing integration

- **To rotate a credential:** click **Disconnect** on the card, then **Connect** again and paste the new value.
- **To remove an integration entirely:** click **Disconnect**. The card returns to the unconnected state and the agent loses access to that service on the next turn.
- **Coming Soon cards** cannot be connected yet — the **Connect** button is hidden.

## Troubleshooting

- **The agent says an integration isn't connected even though you just saved it:** wait for the next turn. Newly-saved credentials become visible to the agent on the following turn.
- **Credentials stopped working:** disconnect and reconnect the card with a fresh token. The agent will also notify the admin if it detects expired credentials during a turn.
- **You can't find the Integrations page:** make sure you've selected the right workspace in the top-left workspace switcher — the Integrations panel is workspace-scoped.

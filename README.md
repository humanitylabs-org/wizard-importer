# Importer (Wizard OS app)

Bring your memories, chats, skills and personality from ChatGPT, Claude, Claude Code or another Hermes agent into your Wizard.

- Step-by-step in-app guides to get each export (checked against OpenAI's and Anthropic's help pages), with direct links to the right settings page.
- Waits for the export: watches Files › Inbox and Downloads, and with the Mail app spots the export email and its link; continues on its own when the zip lands.
- Agents on this box (Claude Code, other Hermes homes) are offered with one tap, no export needed.
- Preview counts, choose what comes in, edit and approve a "What I know about you" card before anything is saved. Every import can be undone.

The app parses and stores nothing itself: it relays to the `wizard-os` Hermes plugin's bring-data engine (`/api/plugins/wizard-os/bring-data/*`, humanitylabs-org/wizard-agent-service). Tests: `python3 tests/test_server.py`.

## Switches (Try it)

| Switch | Off (default) | On |
| --- | --- | --- |
| `hermes-history` (Bring your Wizard, humanitylabs-org/wizard-agent-service#544) | A Hermes source imports as before | "Another Hermes agent": its chats, dated memories and facts come in as read-only History, skills as documents to read (never active skills), and only the scheduled jobs you tick, paused. Sign-ins, settings, personality and other profiles stay behind. Needs the Agent Service with the history engine. |

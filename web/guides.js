'use strict';
/* How to get each export, shown in the app so nobody has to coach the owner.
 * Every step and link is checked against the provider's own help page (cited in `source`), checked 4 Nov 2026:
 *  - ChatGPT: https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data
 *    (web: profile menu > Settings > Data controls > Export data: Export > Confirm export; email or SMS with
 *    "Download data export"; up to 7 days; link expires 24 h after it arrives; Business/Enterprise: no self-service).
 *    The direct link chatgpt.com/#settings/DataControls opens that settings pane (widely used; the help page
 *    gives the clicks, which are also shown). Privacy Portal fallback: https://privacy.openai.com
 *  - Claude: https://support.claude.com/en/articles/9450526-export-your-claude-data
 *    (Settings > Privacy > Export data, web or Claude Desktop only, not the phone apps; email link; expires 24 h;
 *    Team/Enterprise: an owner turns on "Allow members to export their own data"). The direct address
 *    claude.ai/settings/data-privacy-controls is the Privacy page Anthropic's own Claude Code docs link to
 *    (https://code.claude.com/docs/en/data-usage).
 *  - Claude Code: https://code.claude.com/docs/en/memory (~/.claude/CLAUDE.md, auto memory under
 *    ~/.claude/projects/<project>/memory/) and https://code.claude.com/docs/en/data-usage (session transcripts in
 *    ~/.claude/projects/, kept 30 days by default: cleanupPeriodDays).
 *  - Hermes: `hermes backup --help` (zip of the Hermes home; default ~/hermes-backup-<timestamp>.zip).
 * Data only: app.js renders these with textContent. */
window.ImporterGuides = {
  chatgpt: {
    id: 'chatgpt', name: 'ChatGPT', mark: '/wizard-os-home/brand/apps/chatgpt.svg', mono: true,
    tile: 'Memories, custom instructions and chats. ChatGPT emails you a download link.',
    intro: 'Ask ChatGPT for a copy. Free, about a minute.',
    steps: [
      'Open ChatGPT settings.',
      'Tap Export data, then Confirm.',
    ],
    phone: 'Phone app: Settings › Data controls › Export data.',
    link: { label: 'Open ChatGPT', url: 'https://chatgpt.com/#settings/DataControls' },
    next: 'Waiting for ChatGPT’s email…',
    expect: [
      'The email usually comes in minutes (up to 7 days). Its link works for 24 hours; check spam.',
      'Download signed in to the same ChatGPT account.',
    ],
    notes: [
      'Work accounts (ChatGPT Business or Enterprise) can’t export themselves: ask your workspace owner.',
      'Can’t sign in? Ask through OpenAI’s Privacy Portal: Make a Privacy Request › I have a consumer ChatGPT account › Download my data.',
    ],
    portal: { label: 'OpenAI Privacy Portal', url: 'https://privacy.openai.com' },
    file: 'a .zip file',
    mail: /openai|chatgpt/i,
    help: 'https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data', helpName: 'OpenAI’s help page for these steps',
  },
  claude: {
    id: 'claude', name: 'Claude', mark: '/wizard-os-home/brand/apps/claude.svg',
    tile: 'Chats, projects and memory from claude.ai. Claude emails you a download link.',
    intro: 'Ask Claude for a copy. Use a computer: the phone apps can’t export.',
    steps: [
      'Open Claude settings on a computer.',
      'Click Export data.',
    ],
    phone: '',
    link: { label: 'Open Claude', url: 'https://claude.ai/settings/data-privacy-controls' },
    next: 'Waiting for Claude’s email…',
    expect: [
      'The email link works for 24 hours. If it expires, just ask again.',
      'Got a small .json with several links instead of a zip? Drop it here and the Importer opens each link.',
    ],
    notes: [
      'On a Team or Enterprise plan, an owner first turns on “Allow members to export their own data”.',
    ],
    file: 'a .zip file (or a small .json with links)',
    mail: /anthropic|claude/i,
    help: 'https://support.claude.com/en/articles/9450526-export-your-claude-data', helpName: 'Anthropic’s help page for these steps',
  },
  'claude-code': {
    id: 'claude-code', name: 'Claude Code', mark: '/wizard-os-home/brand/apps/claude.svg', glyph: '>_',
    tile: 'Your CLAUDE.md, project memory, sessions, skills and commands. No export needed.',
    intro: 'Claude Code keeps everything in a folder called .claude in your home folder. Nothing to request.',
    steps: [
      'If Claude Code runs on this Wizard, it is listed above: tap it.',
      'On another computer, make a zip of that folder without your sign-in. Mac or Linux, in Terminal:',
    ],
    command: 'cd ~ && zip -r claude-code.zip .claude -x ".claude/.credentials.json" ".claude/.claude.json" ".claude/settings*.json" ".claude/plugins/*"',
    after: 'Windows: copy the .claude folder from your user folder, delete .credentials.json and the settings files from the copy, then right-click it › Send to › Compressed (zipped) folder. Drop that zip here.',
    expect: [
      'Your sign-in (.credentials.json), settings files and plugins are never read.',
      'Claude Code keeps sessions for 30 days unless you changed cleanupPeriodDays, so older sessions may already be gone.',
    ],
    notes: [],
    file: 'claude-code.zip',
    help: 'https://code.claude.com/docs/en/memory', helpName: 'Claude Code docs: where it keeps memory',
  },
  hermes: {
    id: 'hermes', name: 'Hermes', mark: '/wizard-os-home/brand/apps/hermes.svg', mono: true,
    tile: 'Another Hermes agent: personality, memories, skills and sessions.',
    intro: 'Bring a Hermes agent: its personality (SOUL.md), memories, skills and past sessions.',
    steps: [
      'If that Hermes runs on this Wizard, it is listed above: tap it.',
      'On another machine, zip just its data (no keys or sign-ins) in Terminal:',
    ],
    command: 'cd ~ && zip -r hermes-export.zip .hermes/SOUL.md .hermes/memories .hermes/skills .hermes/state.db',
    after: 'A full `hermes backup` zip works too; the Importer never reads its .env, auth or config files. Then drop the zip here.',
    expect: ['A big agent can take a minute to read.'],
    notes: [],
    file: 'hermes-export.zip',
    help: '',
  },
  other: {
    id: 'other', name: 'Other', glyph: '+',
    tile: 'Any export zip or folder. The Importer works out what it is.',
    intro: 'Drop any export zip here, or type the name of a file or folder in your Files.',
    steps: ['Drop the file below, or pick it from your Files.'],
    expect: ['ChatGPT, Claude, Claude Code and Hermes are recognized today. Codex and others are coming.'],
    notes: [],
    file: 'the export',
    help: '',
  },
};

# nexudus-mcp

An MCP server that lets [Claude Code](https://claude.ai/claude-code) book and manage rooms in [Nexudus](https://nexudus.com/) coworking spaces using natural language.

> "Book me a conference room tomorrow at 2pm for 6 people"

## What it does

- List rooms with capacity and amenities
- Check availability for a time window
- Book rooms by name (fuzzy matching)
- View your upcoming bookings
- Cancel bookings
- View a room's schedule for a given day

## Setup

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- A Nexudus member account with login credentials
- Your portal URL (e.g., `yourspace.spaces.nexudus.com`)
- Node.js 18+

### Quick setup (let Claude do it)

Tell Claude Code:

> Clone github.com/jude-stiel/nexudus-mcp and set it up as an MCP server for Nexudus room booking

Claude will walk you through the rest. Or do it manually:

### Manual setup

1. **Clone and build**

```bash
git clone https://github.com/jude-stiel/nexudus-mcp.git
cd nexudus-mcp
npm install
npm run build
```

2. **Create `.env`**

```bash
cat > .env << 'EOF'
NEXUDUS_EMAIL=your-email@example.com
NEXUDUS_PASSWORD=your-password
NEXUDUS_PORTAL=yourspace.spaces.nexudus.com
NEXUDUS_COWORKER_ID=your-coworker-id
EOF
```

- **NEXUDUS_EMAIL** / **NEXUDUS_PASSWORD** — your Nexudus login credentials
- **NEXUDUS_PORTAL** — your space's portal hostname (check your browser URL bar when logged in)
- **NEXUDUS_COWORKER_ID** — *(optional)* your member ID in Nexudus. If omitted, the server extracts it from your existing bookings. To find it manually: open DevTools on the portal, book a room, and look for `CoworkerId` in the network request body.

3. **Test your credentials**

```bash
read -rs 'pass?Password: ' && echo && curl -s -X POST https://spaces.nexudus.com/api/token \
  --data-urlencode 'grant_type=password' \
  --data-urlencode "username=YOUR_EMAIL" \
  --data-urlencode "password=$pass" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Token OK' if 'access_token' in d else f'Auth failed: {d}')"
```

4. **Register with Claude Code**

Add to `.mcp.json` in your working directory (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "nexudus-rooms": {
      "command": "/absolute/path/to/nexudus-mcp/start.sh"
    }
  }
}
```

5. **Restart Claude Code** — the server will connect automatically on startup.

## Usage

Just talk to Claude naturally:

| You say | What happens |
|---------|-------------|
| "What rooms are available at 2pm tomorrow?" | Searches availability for conference rooms |
| "Book Fenway Room Thursday 10-11am" | Books the room via the checkout flow |
| "What do I have booked this week?" | Lists your upcoming bookings |
| "Cancel my 3pm booking" | Looks up the booking ID and cancels it |
| "What's the schedule for Brattle Room today?" | Shows all bookings for that room |
| "I need a room for 8 people tomorrow at noon" | Searches, filters by capacity, suggests options |

## How it works

The server authenticates with Nexudus using your member credentials (OAuth bearer token) and calls the same portal API endpoints that the Nexudus web portal uses. It does **not** require admin API access.

See [WALKTHROUGH.md](WALKTHROUGH.md) for a detailed technical explanation of the architecture, API reverse-engineering process, and obstacles overcome.

## Limitations

- **Member-level access only** — uses the portal API, not the admin REST API. This works for booking and cancelling your own rooms but can't perform admin operations.
- **Availability data** — the portal returns bookings for the current month. Availability checks for dates far in the future may be incomplete.
- **No recurring bookings yet** — each booking is a one-off. The Nexudus data model supports repeating bookings but the creation flow hasn't been implemented.
- **Token refresh** — tokens are cached and refreshed automatically, but if your password changes you'll need to update `.env` and restart.

## License

MIT

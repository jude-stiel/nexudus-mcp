# Nexudus Room Booking MCP Server — Technical Walkthrough

This document covers how the server works, the key architectural choices, and the obstacles overcome during development.

## How It Works

The server runs as a local Node.js process that Claude Code launches automatically on startup via the MCP (Model Context Protocol) stdio transport. It exposes six tools:

| Tool | What it does |
|------|-------------|
| `list_rooms` | List all bookable resources with capacity and amenities. Optional type filter. |
| `search_available_rooms` | Given a date and time window, returns which rooms are free vs. booked. |
| `get_room_schedule` | Shows all bookings for a specific room on a given date. |
| `book_room` | Books a room. Accepts room name (fuzzy match), date, start/end time, optional notes. |
| `my_bookings` | Lists your upcoming bookings (optionally includes past). |
| `cancel_booking` | Cancels a booking by ID. |

Claude interprets natural language ("book me a conference room tomorrow at 2 for 6 people") and translates it into the appropriate tool calls — checking availability, filtering by capacity, and booking the best fit.

## Architecture

```
User (natural language)
  -> Claude Code (interprets intent, picks tools)
    -> MCP Server (nexudus-mcp, stdio transport)
      -> Nexudus Portal API (yourspace.spaces.nexudus.com)
```

The MCP server authenticates with Nexudus using OAuth bearer tokens, caches room and booking data for 2 minutes, and handles token refresh automatically.

### Files

```
nexudus-mcp/
  .env              # Credentials (not in git)
  .gitignore
  start.sh          # Wrapper that loads .env and runs the server
  package.json
  tsconfig.json
  src/index.ts      # The entire MCP server (~530 lines)
  dist/index.js     # Compiled output
```

The server is registered in `.mcp.json` at the project root, which tells Claude Code to launch `start.sh` on startup.

## Key Decisions

### Portal API, not the REST API

Nexudus has two API surfaces:

1. **REST API** (`spaces.nexudus.com/api/...`) — full admin CRUD, requires admin-level API access enabled on the user account
2. **Portal API** (`yourspace.spaces.nexudus.com/...`) — member-facing, same endpoints the web portal's React frontend uses

The REST API returns 401 for standard member accounts even with a valid bearer token. Since most coworking space members don't have admin API access, the server uses the Portal API exclusively. This required reverse-engineering the portal's actual HTTP calls rather than using the documented admin API.

### Single-endpoint data fetch

`GET /api/bookings` on the portal returns a rich object containing `Resources` (all rooms), `Bookings` (user's own), `AllBookings` (everyone's), and `ResourceTypes` — all in one call. The server caches this for 2 minutes and derives room lists, availability, and booking data from it without making separate API calls.

### Booking via basket/checkout flow

Creating a booking is not a simple POST. The Nexudus portal uses a shopping-cart metaphor:

1. `POST /en/basket/PreviewCheckout` — validates the booking and returns pricing
2. `POST /en/basket/CreateInvoice` — actually creates the booking

The payload wraps the booking in a basket array:

```json
{
  "basket": [{
    "type": "booking",
    "booking": {
      "UniqueId": "<random-uuid>",
      "FromTime": "2026-03-25T16:00:00.000Z",
      "ToTime": "2026-03-25T17:00:00.000Z",
      "ResourceId": 1234567890,
      "CoworkerId": 1234567891,
      "Notes": "",
      "CustomFields": { "Data": [] },
      "BookingVisitors": [],
      "BookingProducts": []
    }
  }],
  "discountCode": null,
  "agreedTermsAndConditions": true
}
```

This was discovered by capturing browser network traffic (Chrome DevTools HAR export) during a manual booking.

### Cancellation via deletejson endpoint

Cancelling is a POST (not DELETE):

```
POST /en/bookings/deletejson/{bookingId}
Body: {"cancellationReason": "NoLongerNeeded", "cancellationReasonDetails": null}
```

Also discovered via HAR capture. Standard REST patterns (DELETE to various paths) all returned 404.

### Timezone handling

Nexudus returns local times without timezone suffixes (e.g., `2026-03-25T16:00:00`). The server constructs a local ISO string for comparison rather than using `Date.toISOString()` (which outputs UTC), avoiding false "no upcoming bookings" results caused by the UTC offset.

### Room fuzzy matching

Room names like "Main Conference Room" are matched flexibly — you can say "Fenway", "fenway room", or pass the numeric ID. The server tries exact match, then substring match, then numeric ID match.

## Obstacles Overcome

### 1. Admin API access denied

The documented Nexudus REST API returned 401 even with a valid bearer token. The token endpoint (`POST /api/token` with `grant_type=password`) works for all users, but the data endpoints require admin privileges that most member accounts don't have.

**Solution:** Switch entirely to the portal API, which accepts the same bearer token but serves member-appropriate data.

### 2. Finding the right portal endpoints

The portal is a Next.js/React app with MobX stores. Its API endpoints aren't publicly documented. We systematically probed dozens of URL paths with status-code-only checks to map which endpoints exist and accept bearer token auth:

- `GET /api/bookings` — room + booking data (200)
- `GET /api/auth/me` — user profile (200)
- `POST /en/basket/CreateInvoice` — booking creation (200)
- `POST /en/bookings/deletejson/{id}` — cancellation (200)

Most other paths returned 401, 404, or 500.

### 3. POST to /api/bookings was a no-op

`POST /api/bookings` returned 200 regardless of body content but always returned the same page data as GET — it silently ignored the POST body. The actual booking creation goes through the basket/checkout flow at `/en/basket/CreateInvoice`.

### 4. Discovering the real request format

The booking and cancellation formats were discovered by capturing HAR (HTTP Archive) files from Chrome DevTools while manually performing operations in the portal. Key findings:

- Bookings use a basket → preview → invoice flow, not a direct POST
- The portal sends an `nx-app-version` header
- Cancellation uses `POST /en/bookings/deletejson/{id}`
- Each booking requires a CoworkerId (your member ID in the Nexudus system)

### 5. Empty response handling

`CreateInvoice` returns HTTP 200 with `content-length: 0` on success — no body at all. The server's response parser needed to handle empty bodies gracefully rather than throwing a JSON parse error.

### 6. Timezone comparison bug

Initial implementation compared Nexudus local times (`2026-03-25T16:00:00`) against JavaScript's `new Date().toISOString()` which produces UTC (`2026-03-25T20:25:00.000Z`). String comparison made 4 PM local look earlier than 8:25 PM UTC, so all bookings appeared to be in the past.

**Solution:** Build a local ISO string from `Date` component methods (getFullYear, getMonth, etc.) without timezone suffix, matching the format Nexudus uses.

## Potential Future Enhancements

- **Modify bookings** — change time or room (would require another HAR capture)
- **Recurring bookings** — the Nexudus data model supports `RepeatBooking` fields
- **Amenity filtering** — "I need a room with a whiteboard" (data is already available)

#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TOKEN_URL = "https://spaces.nexudus.com/api/token";
const PORTAL = process.env.NEXUDUS_PORTAL ?? "";
const PORTAL_API = `https://${PORTAL}/api`;
const PORTAL_BASE = `https://${PORTAL}`;
const EMAIL = process.env.NEXUDUS_EMAIL ?? "";
const PASSWORD = process.env.NEXUDUS_PASSWORD ?? "";

if (!EMAIL || !PASSWORD || !PORTAL) {
  console.error(
    "Required env vars: NEXUDUS_EMAIL, NEXUDUS_PASSWORD, NEXUDUS_PORTAL\n" +
      "Example: NEXUDUS_PORTAL=yourspace.spaces.nexudus.com",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth – bearer token with auto-refresh
// ---------------------------------------------------------------------------
let token: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiry) return token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: EMAIL,
      password: PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new Error(`Nexudus auth failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  token = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
  return token!;
}

// ---------------------------------------------------------------------------
// Portal API helper
// ---------------------------------------------------------------------------
async function portal(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const t = await getToken();
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "nx-app-version": "4.0.901",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  // Paths starting with /en/ go to portal base, others to /api/
  const url = path.startsWith("/en/")
    ? `${PORTAL_BASE}${path}`
    : `${PORTAL_API}${path}`;
  const res = await fetch(url, opts);

  if (res.status === 429) {
    const retry = res.headers.get("Retry-After") ?? "10";
    throw new Error(`Nexudus rate limit hit. Retry after ${retry} seconds.`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nexudus ${method} ${path} → ${res.status}: ${text}`);
  }

  // Some endpoints (e.g., CreateInvoice) return empty body on success
  const contentLength = res.headers.get("content-length");
  if (contentLength === "0") return {};

  const text = await res.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { rawResponse: text };
  }
}

// ---------------------------------------------------------------------------
// Data cache – /api/bookings returns everything in one call
// ---------------------------------------------------------------------------
interface BookingsPageData {
  Resources: any[];
  Bookings: any[];
  AllBookings: any[];
  ResourceTypes: any[];
}

let pageCache: BookingsPageData | null = null;
let pageCacheTime = 0;
const PAGE_TTL = 2 * 60 * 1000; // 2 minutes

async function getBookingsPage(forceRefresh = false): Promise<BookingsPageData> {
  if (!forceRefresh && pageCache && Date.now() - pageCacheTime < PAGE_TTL) {
    return pageCache;
  }
  const data = await portal("GET", "/bookings");
  pageCache = {
    Resources: data.Resources ?? [],
    Bookings: data.Bookings ?? [],
    AllBookings: data.AllBookings ?? [],
    ResourceTypes: data.ResourceTypes ?? [],
  };
  pageCacheTime = Date.now();
  return pageCache;
}

async function getRooms(): Promise<any[]> {
  const page = await getBookingsPage();
  return page.Resources;
}

async function getAllBookings(): Promise<any[]> {
  const page = await getBookingsPage();
  // AllBookings includes all visible bookings; Bookings is the user's own
  return page.AllBookings.length ? page.AllBookings : page.Bookings;
}

async function getMyBookings(): Promise<any[]> {
  const page = await getBookingsPage(true); // Always fresh for "my bookings"
  return page.Bookings;
}

let coworkerIdCache: number | null = process.env.NEXUDUS_COWORKER_ID
  ? parseInt(process.env.NEXUDUS_COWORKER_ID, 10)
  : null;

async function getCoworkerId(): Promise<number> {
  if (coworkerIdCache) return coworkerIdCache;
  // Extract from existing bookings (they contain CoworkerId)
  const page = await getBookingsPage();
  if (page.Bookings.length > 0) {
    coworkerIdCache = page.Bookings[0].CoworkerId;
    return coworkerIdCache!;
  }
  // Fallback: try auth/me endpoint — some portal versions expose CoworkerId
  try {
    const me = await portal("GET", "/auth/me");
    if (me.Id) {
      coworkerIdCache = me.Id;
      return coworkerIdCache!;
    }
  } catch {
    // ignore
  }
  throw new Error(
    "Could not determine your CoworkerId. You need at least one existing booking, " +
      "or set NEXUDUS_COWORKER_ID in your .env file.",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function matchRoom(rooms: any[], query: string): any | null {
  const q = query.toLowerCase().trim();

  // Exact name match
  let hit = rooms.find((r) => r.Name.toLowerCase() === q);
  if (hit) return hit;

  // Partial / substring match
  hit = rooms.find((r) => r.Name.toLowerCase().includes(q));
  if (hit) return hit;

  // Numeric ID match
  const id = parseInt(query, 10);
  if (!isNaN(id)) {
    hit = rooms.find((r) => r.Id === id);
    if (hit) return hit;
  }

  return null;
}

function amenitiesList(r: any): string[] {
  return [
    r.Projector && "projector",
    r.WhiteBoard && "whiteboard",
    r.ConferencePhone && "conference phone",
    r.LargeDisplay && "large display",
    r.Internet && "internet",
    r.Catering && "catering",
    r.AirConditioning && "AC",
    r.NaturalLight && "natural light",
    r.Soundproof && "soundproof",
    r.VideoConferencing && "video conferencing",
  ].filter(Boolean) as string[];
}

function formatRoom(r: any): string {
  const parts = [`${r.Name} (ID: ${r.Id})`];
  if (r.Allocation) parts.push(`capacity ${r.Allocation}`);
  if (r.ResourceTypeName) parts.push(r.ResourceTypeName);
  const amen = amenitiesList(r);
  if (amen.length) parts.push(amen.join(", "));
  if (r.Description) parts.push(r.Description);
  return parts.join(" — ");
}

function overlaps(
  bookingFrom: string,
  bookingTo: string,
  rangeFrom: string,
  rangeTo: string,
): boolean {
  return (
    new Date(bookingFrom) < new Date(rangeTo) &&
    new Date(bookingTo) > new Date(rangeFrom)
  );
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function roomList(rooms: any[]): string {
  return rooms.map((r) => `  - ${r.Name}`).join("\n");
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "nexudus-rooms",
  version: "1.0.0",
});

// ---- list_rooms ----------------------------------------------------------
server.tool(
  "list_rooms",
  "List all bookable rooms with capacity and amenities. Can filter by type (Conference Room, Lab Equipment, Wellness Room).",
  {
    type: z
      .string()
      .optional()
      .describe(
        "Filter by resource type, e.g. 'Conference Room', 'Lab Equipment', 'Wellness Room'",
      ),
  },
  async ({ type }) => {
    const rooms = await getRooms();
    const filtered = type
      ? rooms.filter(
          (r) =>
            r.ResourceTypeName?.toLowerCase().includes(type.toLowerCase()),
        )
      : rooms;

    if (!filtered.length) {
      return {
        content: [
          {
            type: "text",
            text: type
              ? `No rooms matching type "${type}".`
              : "No bookable rooms found.",
          },
        ],
      };
    }

    const text = filtered.map(formatRoom).join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// ---- search_available_rooms ----------------------------------------------
server.tool(
  "search_available_rooms",
  "Find which rooms are free during a specific time window",
  {
    date: z.string().describe("Date in YYYY-MM-DD format"),
    start_time: z.string().describe("Start time in HH:MM 24-hour format"),
    end_time: z.string().describe("End time in HH:MM 24-hour format"),
    type: z
      .string()
      .optional()
      .describe("Filter by resource type, e.g. 'Conference Room'"),
  },
  async ({ date, start_time, end_time, type }) => {
    const from = `${date}T${start_time}:00`;
    const to = `${date}T${end_time}:00`;

    const [rooms, bookings] = await Promise.all([
      getRooms(),
      getAllBookings(),
    ]);

    const filtered = type
      ? rooms.filter((r) =>
          r.ResourceTypeName?.toLowerCase().includes(type.toLowerCase()),
        )
      : rooms;

    const busyRoomIds = new Set(
      bookings
        .filter((b: any) => overlaps(b.FromTime, b.ToTime, from, to))
        .map((b: any) => b.ResourceId),
    );

    const available = filtered.filter((r) => !busyRoomIds.has(r.Id));
    const booked = filtered.filter((r) => busyRoomIds.has(r.Id));

    let text = `Rooms on ${date}, ${start_time}–${end_time}:\n\n`;
    text += `AVAILABLE (${available.length}):\n`;
    text += available.length
      ? available.map((r) => `  + ${formatRoom(r)}`).join("\n")
      : "  (none)";
    text += `\n\nBOOKED (${booked.length}):\n`;
    text += booked.length
      ? booked.map((r) => `  - ${formatRoom(r)}`).join("\n")
      : "  (none)";

    return { content: [{ type: "text", text }] };
  },
);

// ---- get_room_schedule ---------------------------------------------------
server.tool(
  "get_room_schedule",
  "View all bookings for a specific room on a given date",
  {
    room: z
      .string()
      .describe("Room name (partial match OK) or numeric room ID"),
    date: z.string().describe("Date in YYYY-MM-DD format"),
  },
  async ({ room, date }) => {
    const rooms = await getRooms();
    const matched = matchRoom(rooms, room);
    if (!matched) {
      return {
        content: [
          {
            type: "text",
            text: `No room matching "${room}". Rooms:\n${roomList(rooms)}`,
          },
        ],
      };
    }

    const bookings = await getAllBookings();
    const dayStart = `${date}T00:00:00`;
    const dayEnd = `${date}T23:59:59`;

    const roomBookings = bookings
      .filter(
        (b: any) =>
          b.ResourceId === matched.Id &&
          overlaps(b.FromTime, b.ToTime, dayStart, dayEnd),
      )
      .sort(
        (a: any, b: any) =>
          new Date(a.FromTime).getTime() - new Date(b.FromTime).getTime(),
      );

    if (!roomBookings.length) {
      return {
        content: [
          {
            type: "text",
            text: `No bookings for "${matched.Name}" on ${date} — it's wide open.`,
          },
        ],
      };
    }

    const lines = roomBookings.map(
      (b: any) =>
        `  ${fmtTime(b.FromTime)}–${fmtTime(b.ToTime)}` +
        (b.Notes ? ` — "${b.Notes}"` : ""),
    );

    return {
      content: [
        {
          type: "text",
          text: `Schedule for "${matched.Name}" on ${date}:\n\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ---- book_room -----------------------------------------------------------
server.tool(
  "book_room",
  "Book a room for a specific time slot",
  {
    room: z
      .string()
      .describe("Room name (partial match OK) or numeric room ID"),
    date: z.string().describe("Date in YYYY-MM-DD format"),
    start_time: z.string().describe("Start time in HH:MM 24-hour format"),
    end_time: z.string().describe("End time in HH:MM 24-hour format"),
    notes: z.string().optional().describe("Optional booking notes"),
  },
  async ({ room, date, start_time, end_time, notes }) => {
    const rooms = await getRooms();
    const matched = matchRoom(rooms, room);
    if (!matched) {
      return {
        content: [
          {
            type: "text",
            text: `No room matching "${room}". Rooms:\n${roomList(rooms)}`,
          },
        ],
      };
    }

    const coworkerId = await getCoworkerId();
    const fromISO = `${date}T${start_time}:00.000Z`;
    const toISO = `${date}T${end_time}:00.000Z`;
    const bookingUniqueId = crypto.randomUUID();

    const basketPayload = {
      basket: [
        {
          type: "booking",
          booking: {
            UniqueId: bookingUniqueId,
            FromTime: fromISO,
            ToTime: toISO,
            CustomFields: { Data: [] },
            ResourceId: matched.Id,
            CoworkerId: coworkerId,
            Notes: notes ?? "",
            BookingVisitors: [],
            BookingProducts: [],
          },
        },
      ],
      discountCode: null,
      agreedTermsAndConditions: true,
    };

    // Step 1: Preview the invoice to validate the booking
    const preview = await portal(
      "POST",
      "/en/basket/PreviewCheckout?createZeroValueInvoice=true&discountCode=",
      basketPayload,
    );

    // Check for errors in preview
    if (preview.Errors?.length) {
      const errMsg = preview.Errors.map((e: any) => e.Message).join("; ");
      return {
        content: [{ type: "text", text: `Booking failed (preview): ${errMsg}` }],
      };
    }
    if (preview.Message && preview.WasSuccessful === false) {
      return {
        content: [{ type: "text", text: `Booking failed: ${preview.Message}` }],
      };
    }

    // Step 2: Create the invoice (actually books the room)
    const result = await portal(
      "POST",
      "/en/basket/CreateInvoice",
      basketPayload,
    );

    // Invalidate cache after booking
    pageCache = null;

    // CreateInvoice returns empty body on success (status 200)
    // Check for error responses
    if (result?.WasSuccessful === false) {
      return {
        content: [
          {
            type: "text",
            text: `Booking failed: ${result.Message ?? "Unknown error"}`,
          },
        ],
      };
    }
    if (result?.Errors?.length) {
      const errMsg = result.Errors.map((e: any) => e.Message).join("; ");
      return {
        content: [{ type: "text", text: `Booking failed: ${errMsg}` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Booked "${matched.Name}" on ${date} from ${start_time} to ${end_time}.`,
        },
      ],
    };
  },
);

// ---- my_bookings ---------------------------------------------------------
server.tool(
  "my_bookings",
  "List your upcoming (or recent past) bookings",
  {
    include_past: z
      .boolean()
      .optional()
      .describe("Include past bookings (default: false, shows future only)"),
  },
  async ({ include_past }) => {
    const bookings = await getMyBookings();

    let filtered = bookings;
    if (!include_past) {
      // Nexudus returns local times without timezone suffix (e.g. "2026-03-25T16:00:00").
      // Compare against local ISO string (no Z) to avoid UTC mismatch.
      const now = new Date();
      const localISO =
        now.getFullYear() +
        "-" +
        String(now.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(now.getDate()).padStart(2, "0") +
        "T" +
        String(now.getHours()).padStart(2, "0") +
        ":" +
        String(now.getMinutes()).padStart(2, "0") +
        ":" +
        String(now.getSeconds()).padStart(2, "0");
      filtered = bookings.filter((b: any) => b.ToTime > localISO);
    }

    if (!filtered.length) {
      return {
        content: [{ type: "text", text: "No upcoming bookings." }],
      };
    }

    const lines = filtered
      .sort(
        (a: any, b: any) =>
          new Date(a.FromTime).getTime() - new Date(b.FromTime).getTime(),
      )
      .map((b: any) => {
        const roomName = b.ResourceName ?? `Room ${b.ResourceId}`;
        return (
          `  [ID ${b.Id}] ${roomName} — ${fmtDate(b.FromTime)} ${fmtTime(b.FromTime)}–${fmtTime(b.ToTime)}` +
          (b.Notes ? ` — "${b.Notes}"` : "")
        );
      });

    return {
      content: [
        { type: "text", text: `Your bookings:\n\n${lines.join("\n")}` },
      ],
    };
  },
);

// ---- cancel_booking ------------------------------------------------------
server.tool(
  "cancel_booking",
  "Cancel a booking by its ID",
  {
    booking_id: z.number().describe("The booking ID to cancel"),
  },
  async ({ booking_id }) => {
    const result = await portal("POST", `/en/bookings/deletejson/${booking_id}`, {
      cancellationReason: "NoLongerNeeded",
      cancellationReasonDetails: null,
    });

    // Invalidate cache after cancellation
    pageCache = null;

    if (result?.WasSuccessful === false) {
      return {
        content: [
          {
            type: "text",
            text: `Cancel failed: ${result.Message ?? "Unknown error"}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Booking ${booking_id} cancelled.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

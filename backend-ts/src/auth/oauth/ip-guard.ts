/**
 * Which addresses an outbound fetch of a client's metadata document may connect to (MCP OAuth, CIMD).
 *
 * The authorization server fetches a URL a stranger chose (the `client_id`), so it must never reach the
 * host's own network: loopback, private ranges, link-local (cloud metadata at 169.254.169.254), carrier NAT,
 * benchmarking, multicast and reserved space, in IPv4 and IPv6, including IPv4 written inside IPv6 (mapped,
 * NAT64, 6to4). The check runs on every address DNS returns, at connect time (`cimd.ts`), so a name that
 * resolves to a public address for a check and a private one for the connection cannot slip through.
 */
import { isIP } from "node:net";

const v4ToInt = (ip: string): number => ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 3], // multicast 224/4 and reserved 240/4, broadcast
];

function v4Blocked(ip: string): boolean {
  const value = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(base) & mask);
  });
}

/** The 8 hextets of an IPv6 address (handles `::` and a trailing dotted IPv4). */
function hextets(ip: string): number[] | null {
  let address = ip.toLowerCase();
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  let tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const maybeV4 = address.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (isIP(maybeV4) !== 4) return null;
    const n = v4ToInt(maybeV4);
    tail = [n >>> 16, n & 0xffff];
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = address.split("::") as [string, string | undefined];
  const parse = (part: string) => (part ? part.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array(Math.max(0, fill)).fill(0), ...right];
  if (all.length !== 8 || all.some((h) => !Number.isInteger(h) || h < 0 || h > 0xffff)) return null;
  if (tail.length) all.splice(6, 2, ...tail);
  return all;
}

const embeddedV4 = (h: number[], from: number): string =>
  [h[from]! >>> 8, h[from]! & 0xff, h[from + 1]! >>> 8, h[from + 1]! & 0xff].join(".");

function v6Blocked(ip: string): boolean {
  const h = hextets(ip);
  if (!h) return true; // unparseable: never connect
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4Blocked(embeddedV4(h, 6)); // ::ffff:a.b.c.d
  if (h.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d (deprecated IPv4-compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 (reaches IPv4 through a translator)
  if (h[0] === 0x2002) return true; // 2002::/16 6to4
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2001 && h[1]! < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo etc.)
  return false;
}

/** True when an address must never be connected to. A string that is not an IP address is refused. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return v4Blocked(address);
  if (family === 6) return v6Blocked(address);
  return true;
}

/**
 * The outbound address guard for client metadata fetches (MCP OAuth, CIMD).
 *   node --import tsx --test src/auth/oauth/ip-guard.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress } from "./ip-guard.ts";

test("internal, reserved and special IPv4 ranges are refused; public addresses are allowed", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "160.79.104.10", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("IPv6: loopback, unspecified, unique-local, link-local, multicast, NAT64, 6to4 and IPv4 inside IPv6 are refused", () => {
  const blocked = [
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::127.0.0.1",
    "64:ff9b::a00:1", "64:ff9b::8.8.8.8", "2002:a00:1::1", "2001:db8::1", "2001::1",
    // Outside global unicast (2000::/3): IPv4-translated, site-local, discard, and unassigned space.
    "::ffff:0:7f00:1", "::ffff:0:8.8.8.8", "fec0::1", "100::1", "4000::1", "e000::1",
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("anything that is not an IP address is refused", () => {
  for (const value of ["", "localhost", "example.com", "1.2.3", "::gg", "1.2.3.4.5"]) assert.equal(isBlockedAddress(value), true, value);
});

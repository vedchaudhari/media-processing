import dns from "node:dns";

/**
 * Overrides the nameservers Node's bundled resolver (c-ares) uses, but ONLY
 * when DNS_SERVERS is set.
 *
 * Why this exists: on some Windows/VPN/corporate setups c-ares defaults to
 * 127.0.0.1 (a dead stub resolver), so every DNS lookup is refused with
 * `ECONNREFUSED querySrv ...`. That breaks `mongodb+srv://` (which needs an SRV
 * lookup) as well as Redis/MinIO host resolution — the process can't reach any
 * dependency even though the OS resolver works fine.
 *
 * The fix is machine/network-specific (the working nameserver here is a
 * private 10.x address; public resolvers like 1.1.1.1 may be firewalled), so
 * we DON'T hardcode a server. Set DNS_SERVERS (comma-separated) in .env on the
 * affected machine, e.g. `DNS_SERVERS=10.228.153.194`. Unset = leave Node's
 * default resolution untouched, so unaffected environments behave normally.
 */
export function configureDns(): void {
  const raw = process.env.DNS_SERVERS;
  if (!raw) return;

  const servers = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (servers.length === 0) return;

  dns.setServers(servers);
  console.log(`DNS resolver overridden via DNS_SERVERS: ${servers.join(", ")}`);
}

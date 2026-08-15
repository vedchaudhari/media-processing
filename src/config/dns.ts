import dns from "node:dns";

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

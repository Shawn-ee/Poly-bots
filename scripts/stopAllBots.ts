import { spawnSync } from "node:child_process";

const services = [
  "poly-market-maker.service",
  "poly-reference-arb.service",
  "poly-liquidity-seeder.service",
  "poly-agent-supervisor.service",
];

for (const service of services) {
  const result = spawnSync("systemctl", ["--user", "stop", service], {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status === 0) {
    console.log(`stopped ${service}`);
    continue;
  }

  const detail = (result.stderr || result.stdout || "").trim();
  console.log(`stop requested for ${service}; status=${result.status}${detail ? ` (${detail})` : ""}`);
}


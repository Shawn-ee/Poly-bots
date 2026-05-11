const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'generated.bots.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const bot of data.bots || []) {
  bot.pollIntervalMs = 1000;
  bot.loopIntervalMinMs = 1000;
  bot.loopIntervalMaxMs = 1000;
  bot.decisionCooldownMs = 3000;
  bot.minQuoteLifetimeMs = Math.max(bot.minQuoteLifetimeMs || 0, 3000);
  bot.capBackoffMs = Math.max(bot.capBackoffMs || 0, 10000);
}
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log(`updated ${data.bots?.length || 0} bots`);

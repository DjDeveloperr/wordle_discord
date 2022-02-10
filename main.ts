import { WordleBot } from "./src/bot.ts";

const bot = new WordleBot();
await bot.connect();
console.log("Connected!");

if (Deno.args.includes("sync")) {
  await bot.syncCommands();
  console.log("Synced Commands!");
}

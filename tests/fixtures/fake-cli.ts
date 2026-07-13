#!/usr/bin/env bun

const args = Bun.argv.slice(2);

if (args[0] === "debug" && args[1] === "models") {
  console.log(JSON.stringify({ models: ["fake-model"] }));
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in");
  process.exit(0);
}

if (args[0] === "exec") {
  const prompt = await Bun.stdin.text();
  console.log(JSON.stringify({ text: `fake:${prompt}` }));
  process.exit(0);
}

console.error(`unexpected fake CLI arguments: ${args.join(" ")}`);
process.exit(2);

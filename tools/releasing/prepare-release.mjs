#!/usr/bin/env node
// Sets the release version and the channel identity before a release build.
//   node tools/releasing/prepare-release.mjs <stable|test> <X.Y.Z> [repository-root]
// A test build gets its own name, app id, and update address, so it installs next to the real app
// and only ever follows the test channel.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, VERSION_PATTERN, writeJson } from "./lib.mjs";

const [channel, version, rootArg] = process.argv.slice(2);
if (!["stable", "test"].includes(channel) || !VERSION_PATTERN.test(version ?? "")) {
  console.error("usage: prepare-release.mjs <stable|test> <X.Y.Z> [repository-root]");
  process.exit(2);
}
const root = rootArg ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgPath = path.join(root, "apps/desktop/package.json");
const configPath = path.join(root, "apps/desktop/update-config.json");

const pkg = readJson(pkgPath);
const config = readJson(configPath);
pkg.version = version;
config.channel = channel;
config.feedUrl = config.feedUrl.replace(/\/+$/, "").replace(/\/test$/, "");
if (channel === "test") {
  pkg.build.appId = `${pkg.build.appId}.updatertest`;
  pkg.build.productName = `${pkg.build.productName} Updater Test`;
  config.feedUrl = `${config.feedUrl}/test`;
}
writeJson(pkgPath, pkg);
writeJson(configPath, config);
console.log(`Prepared ${pkg.build.productName} ${version} on the ${channel} channel (${config.feedUrl})`);

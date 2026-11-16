#!/usr/bin/env node
// Creates latest.json (read by the installed apps) from a folder holding the complete, signed
// release file set. The files themselves are downloaded from the GitHub release with this tag.
//   node tools/releasing/build-manifest.mjs <stable|test> <X.Y.Z> <release-files-dir> <notes-file> <out-file>
// Reads DOWNLOAD_BASE, for example https://github.com/OWNER/REPO/releases/download.
// Fails if any file or signature is missing or empty.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseFileNames, VERSION_PATTERN, writeJson } from "./lib.mjs";

export const releaseTag = (channel, version) => `${channel === "test" ? "test-" : ""}v${version}`;

export function buildManifest({ channel, version, filesDir, notes, downloadBase, now = new Date() }) {
  if (!["stable", "test"].includes(channel)) throw new Error(`Invalid channel: ${channel}`);
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid version: ${version}`);
  if (!/^https:\/\//.test(downloadBase ?? "")) throw new Error("DOWNLOAD_BASE must be an https URL.");
  const base = `${downloadBase.replace(/\/+$/, "")}/${releaseTag(channel, version)}`;
  const names = releaseFileNames(version);
  const required = [names.windows, `${names.windows}.sig`, names.macUpdate, `${names.macUpdate}.sig`, names.macDmg];
  for (const name of required) {
    const file = path.join(filesDir, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing release file: ${name}`);
  }
  const entry = (name) => ({
    signature: fs.readFileSync(path.join(filesDir, `${name}.sig`), "utf8").trim(),
    url: `${base}/${encodeURIComponent(name)}`,
  });
  const mac = entry(names.macUpdate);
  return {
    version,
    notes: notes.trim() || "Improvements and fixes.",
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    // One universal macOS build serves both Apple Silicon and Intel.
    platforms: { "windows-x86_64": entry(names.windows), "darwin-aarch64": mac, "darwin-x86_64": mac },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [channel, version, filesDir, notesFile, outFile] = process.argv.slice(2);
  if (!outFile) {
    console.error("usage: build-manifest.mjs <stable|test> <X.Y.Z> <release-files-dir> <notes-file> <out-file>");
    process.exit(2);
  }
  try {
    writeJson(
      outFile,
      buildManifest({
        channel,
        version,
        filesDir,
        notes: fs.readFileSync(notesFile, "utf8"),
        downloadBase: process.env.DOWNLOAD_BASE,
      }),
    );
    console.log(`Wrote ${outFile} for ${version} (${channel})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

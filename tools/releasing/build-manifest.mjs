#!/usr/bin/env node
// Creates latest.json (read by the installed apps) and downloads.html (first-time download page)
// from a folder holding the complete, signed release file set. The files themselves are downloaded
// from the GitHub release with this tag, because installers are far larger than the 100 MB that a
// Git branch accepts.
//   node tools/releasing/build-manifest.mjs <stable|test> <X.Y.Z> <release-files-dir> <notes-file> <out-dir>
// Reads DOWNLOAD_BASE, for example https://github.com/OWNER/REPO/releases/download.
// Fails if any file or signature is missing or empty.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, releaseFileNames, VERSION_PATTERN, writeJson } from "./lib.mjs";

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
  const url = (name) => `${base}/${encodeURIComponent(name)}`;
  const entry = (name) => ({ signature: fs.readFileSync(path.join(filesDir, `${name}.sig`), "utf8").trim(), url: url(name) });
  const mac = entry(names.macUpdate);
  const manifest = {
    version,
    notes: notes.trim() || "Improvements and fixes.",
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    // One universal macOS build serves both Apple Silicon and Intel.
    platforms: { "windows-x86_64": entry(names.windows), "darwin-aarch64": mac, "darwin-x86_64": mac },
  };
  const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const links = [
    ["Windows (64-bit)", names.windows],
    ["macOS (Apple Silicon and Intel)", names.macDmg],
  ]
    .map(([label, name]) => `<li><a class="button" href="${escape(url(name))}">Download for ${escape(label)}</a></li>`)
    .join("\n");
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex">
<title>Download ${PRODUCT}</title>
<style>body{font:18px system-ui;max-width:720px;margin:64px auto;padding:0 24px;background:#101211;color:#ecefed}ul{list-style:none;padding:0}li{margin:18px 0}.button{display:inline-block;padding:12px 20px;border-radius:8px;background:#5aa56f;color:#101211;text-decoration:none;font-weight:600}</style>
<h1>Download ${PRODUCT} ${escape(version)}</h1><p>Latest release. Channel: ${escape(channel)}</p><ul>
${links}
</ul></html>
`;
  return { manifest, page };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [channel, version, filesDir, notesFile, outDir] = process.argv.slice(2);
  if (!outDir) {
    console.error("usage: build-manifest.mjs <stable|test> <X.Y.Z> <release-files-dir> <notes-file> <out-dir>");
    process.exit(2);
  }
  try {
    const { manifest, page } = buildManifest({
      channel,
      version,
      filesDir,
      notes: fs.readFileSync(notesFile, "utf8"),
      downloadBase: process.env.DOWNLOAD_BASE,
    });
    writeJson(path.join(outDir, "latest.json"), manifest);
    fs.writeFileSync(path.join(outDir, "downloads.html"), page);
    console.log(`Wrote latest.json and downloads.html for ${version} (${channel})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

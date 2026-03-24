#!/usr/bin/env node
// Updates version in package.json, manifest.json, and versions.json in one step.
// Usage: node scripts/bump-version.mjs [patch|minor|major]

import { readFileSync, writeFileSync } from "fs";

const bump = process.argv[2] ?? "patch";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
	writeFileSync(path, JSON.stringify(obj, null, "\t") + "\n");
}

function incrementVersion(version, bump) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const pkg = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");

const oldVersion = pkg.version;
const newVersion = incrementVersion(oldVersion, bump);

pkg.version = newVersion;
manifest.version = newVersion;
versions[newVersion] = manifest.minAppVersion;

writeJson("package.json", pkg);
writeJson("manifest.json", manifest);
writeJson("versions.json", versions);

console.log(`${oldVersion} → ${newVersion}`);

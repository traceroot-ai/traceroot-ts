#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [, , baselinePath, freshPath] = process.argv;
if (!baselinePath || !freshPath) {
  console.error("Usage: check-drift.mjs <baseline.json> <fresh.json>");
  process.exit(2);
}

function load(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function unwrap(e) {
  if (e.source === "stream") return e.payload?.event ?? e.payload;
  if (e.source === "onDelta") return e.payload?.update ?? e.payload;
  return e.payload;
}

function isArtifact(p) {
  if (!p || typeof p !== "object") return false;
  return Boolean(
    p.__caught_error ||
      p.__stream_error ||
      p.__top_level_error ||
      p.__injected ||
      p.__cancel_error,
  );
}

function summarize(events) {
  const byType = new Map();
  for (const e of events) {
    if (!["stream", "onDelta", "onDidChangeStatus"].includes(e.source)) continue;
    const p = unwrap(e);
    if (isArtifact(p)) continue;
    const key = `${e.source}:${p?.type ?? typeof p}`;
    if (!byType.has(key)) byType.set(key, new Set());
    if (p && typeof p === "object") {
      for (const k of Object.keys(p)) byType.get(key).add(k);
    }
  }
  return byType;
}

const baseline = load(baselinePath);
const fresh = load(freshPath);

const sumA = summarize(baseline);
const sumB = summarize(fresh);

const allKeys = new Set([...sumA.keys(), ...sumB.keys()]);

const removedTypes = [];
const addedTypes = [];
const fieldChanges = [];

for (const key of allKeys) {
  if (sumA.has(key) && !sumB.has(key)) {
    removedTypes.push(key);
    continue;
  }
  if (!sumA.has(key) && sumB.has(key)) {
    addedTypes.push(key);
    continue;
  }
  const a = sumA.get(key);
  const b = sumB.get(key);
  const removed = [...a].filter((f) => !b.has(f));
  const added = [...b].filter((f) => !a.has(f));
  if (removed.length || added.length) {
    fieldChanges.push({ key, removed, added });
  }
}

const drift = removedTypes.length > 0 || addedTypes.length > 0 || fieldChanges.length > 0;

console.log(`DRIFT_DETECTED=${drift ? "true" : "false"}`);
console.log("");
console.log("# Cursor SDK fixture drift report");
console.log("");
console.log(`- Baseline: \`${baselinePath}\``);
console.log(`- Fresh:    \`${freshPath}\``);
console.log("");
if (!drift) {
  console.log("No drift detected. Event types and field names match the locked v1 contract.");
  process.exit(0);
}

if (removedTypes.length > 0) {
  console.log("## Event types missing from fresh capture");
  for (const k of removedTypes) console.log(`- \`${k}\``);
  console.log("");
}
if (addedTypes.length > 0) {
  console.log("## New event types in fresh capture");
  for (const k of addedTypes) console.log(`- \`${k}\``);
  console.log("");
}
if (fieldChanges.length > 0) {
  console.log("## Field-set changes per event type");
  console.log("");
  console.log("| Event | Removed fields | Added fields |");
  console.log("|---|---|---|");
  for (const c of fieldChanges) {
    const rm = c.removed.length ? c.removed.map((f) => `\`${f}\``).join(", ") : "—";
    const add = c.added.length ? c.added.map((f) => `\`${f}\``).join(", ") : "—";
    console.log(`| \`${c.key}\` | ${rm} | ${add} |`);
  }
}

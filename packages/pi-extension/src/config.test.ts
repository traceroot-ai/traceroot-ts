import assert from "node:assert/strict";
import { test } from "node:test";
import { envRaw, resolve } from "./config.ts";

test("resolve applies cloud defaults", () => {
  const c = resolve({});
  assert.equal(c.enabled, false);
  assert.equal(c.apiUrl, "https://api.traceroot.ai");
  assert.equal(c.uiUrl, "https://app.traceroot.ai");
  assert.equal(c.otlpEndpoint, "https://api.traceroot.ai/api/v1/public/traces");
  assert.equal(c.project, "pi");
  assert.equal(c.serviceName, "pi-agent");
  assert.equal(c.showUiIndicator, true);
});

test("local mode flips the endpoint and UI defaults", () => {
  const c = resolve({ localMode: true });
  assert.equal(c.apiUrl, "http://localhost:8000");
  assert.equal(c.uiUrl, "http://localhost:3000");
  assert.equal(c.otlpEndpoint, "http://localhost:8000/api/v1/public/traces");
});

test("explicit otlpEndpoint overrides the derived one", () => {
  const c = resolve({ localMode: true, otlpEndpoint: "http://host:9/ingest" });
  assert.equal(c.otlpEndpoint, "http://host:9/ingest");
});

test("envRaw reads only the variables that are set", () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("TRACEROOT_") || k === "PI_PARENT_SPAN_ID" || k === "PI_ROOT_SPAN_ID") {
        delete process.env[k];
      }
    }
    process.env.TRACEROOT_PI_ENABLED = "true";
    process.env.TRACEROOT_TOKEN = "tok";
    process.env.TRACEROOT_LOCAL_MODE = "true";
    const raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, "tok");
    assert.equal(raw.localMode, true);
    assert.equal("project" in raw, false); // unset stays absent so lower layers win
  } finally {
    process.env = saved;
  }
});

test("accepts SDK-standard env names, with legacy names as aliases", () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("TRACEROOT_")) delete process.env[k];
    }
    // SDK-standard names
    process.env.TRACEROOT_ENABLED = "true";
    process.env.TRACEROOT_API_KEY = "sdk-key";
    let raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, "sdk-key");

    // Legacy pi-scoped names still work
    delete process.env.TRACEROOT_ENABLED;
    delete process.env.TRACEROOT_API_KEY;
    process.env.TRACEROOT_PI_ENABLED = "true";
    process.env.TRACEROOT_TOKEN = "legacy-key";
    raw = envRaw();
    assert.equal(raw.enabled, true);
    assert.equal(raw.token, "legacy-key");

    // SDK name wins when both are present
    process.env.TRACEROOT_API_KEY = "sdk-wins";
    assert.equal(envRaw().token, "sdk-wins");
  } finally {
    process.env = saved;
  }
});

test("enabled is false unless env is exactly 'true'", () => {
  const saved = { ...process.env };
  try {
    process.env.TRACEROOT_PI_ENABLED = "1";
    assert.equal(resolve(envRaw()).enabled, false);
  } finally {
    process.env = saved;
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, type TracerootPiConfig } from "./config.ts";
import { applyProjectLocal } from "./project-config.ts";

test("applies allowed project-local fields", () => {
  const config = resolve({});
  const applied = applyProjectLocal(
    config,
    { project: "my-test-project", projectId: "uuid-1", showUiIndicator: false },
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied.sort(), ["project", "projectId", "showUiIndicator"]);
  assert.equal(config.project, "my-test-project");
  assert.equal(config.projectId, "uuid-1");
  assert.equal(config.showUiIndicator, false);
});

test("env-provided fields are not overridden by project-local", () => {
  const config = resolve({ project: "from-env" });
  const applied = applyProjectLocal(
    config,
    { project: "from-file" },
    new Set<keyof TracerootPiConfig>(["project"]),
  );
  assert.deepEqual(applied, []);
  assert.equal(config.project, "from-env");
});

test("never applies the token from a project-local file", () => {
  const config = resolve({});
  applyProjectLocal(
    config,
    { token: "leaked-token", project: "ok" } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.equal(config.token, "");
  assert.equal(config.project, "ok");
});

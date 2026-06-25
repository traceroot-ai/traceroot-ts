import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepoSlug, workspaceName } from "./attribution.ts";

test("parseRepoSlug handles scp-like and https git remotes", () => {
  assert.equal(parseRepoSlug("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseRepoSlug("git@github.com:owner/repo"), "owner/repo");
  assert.equal(parseRepoSlug("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseRepoSlug("https://github.com/owner/repo"), "owner/repo");
  assert.equal(parseRepoSlug("https://gitlab.com/group/sub/repo.git"), "sub/repo");
});

test("parseRepoSlug returns undefined for junk", () => {
  assert.equal(parseRepoSlug(""), undefined);
  assert.equal(parseRepoSlug("not a url"), undefined);
  assert.equal(parseRepoSlug("https://github.com/owner"), undefined); // only one segment
});

test("workspaceName is the cwd basename", () => {
  assert.equal(workspaceName("/a/b/my-project"), "my-project");
});

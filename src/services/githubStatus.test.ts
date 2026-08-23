import { describe, expect, it } from "vitest";
import { githubConnectionTarget } from "./githubStatus";
import { githubConfig } from "../model/overviewFixtures";

describe("GitHub connection cache identity", () => {
  it("does not reuse a verification from another account", () => {
    const first = githubConnectionTarget(githubConfig({ accountId: "account-1" }));
    const second = githubConnectionTarget(githubConfig({ accountId: "account-2" }));
    expect(first).not.toBe(second);
  });

  it("reuses a verification for the same account and destination", () => {
    const config = githubConfig({ accountId: "account-1" });
    expect(githubConnectionTarget(config)).toBe(githubConnectionTarget({ ...config }));
  });
});

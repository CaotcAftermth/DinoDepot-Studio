import { describe, expect, it } from "vitest";
import { profileBackupPath, rawUrl, githubConfigComplete } from "./publish";
import type { GithubConfig } from "../model/project";

const config: GithubConfig = {
  accountId: "9",
  owner: "ggfizz",
  repo: "cluster",
  branch: "main",
  paths: {
    production: "dinodepot/passive-production.json",
    remaps: "dinodepot/creature-remaps.json",
    cosmetics: "dinodepot/custom-cosmetics.txt",
    viewerData: "dinodepot/viewer-data.json",
    viewerPage: "docs/index.html",
    players: "dinodepot/players.json",
    profiles: "dinodepot/profiles",
  },
};

describe("profileBackupPath", () => {
  it("puts the profile inside the configured folder", () => {
    expect(profileBackupPath(config, "112233.arkprofile")).toBe(
      "dinodepot/profiles/112233.arkprofile",
    );
  });

  it("tolerates a trailing slash on the folder setting", () => {
    const withSlash = {
      ...config,
      paths: { ...config.paths, profiles: "dinodepot/profiles/" },
    };
    expect(profileBackupPath(withSlash, "x.arkprofile")).toBe(
      "dinodepot/profiles/x.arkprofile",
    );
  });
});

describe("rawUrl", () => {
  it("builds the RAW URL for the roster", () => {
    expect(rawUrl(config, "players")).toBe(
      "https://raw.githubusercontent.com/ggfizz/cluster/main/dinodepot/players.json",
    );
  });
});

describe("githubConfigComplete", () => {
  it("needs account, owner, repo and branch", () => {
    expect(githubConfigComplete(config)).toBe(true);
    expect(githubConfigComplete({ ...config, accountId: "" })).toBe(false);
    expect(githubConfigComplete({ ...config, owner: "" })).toBe(false);
    expect(githubConfigComplete({ ...config, repo: "" })).toBe(false);
    expect(githubConfigComplete({ ...config, branch: "" })).toBe(false);
  });
});

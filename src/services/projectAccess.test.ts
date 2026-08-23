import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import {
  inviteRepositoryCollaborator,
  normalizeGitHubLogin,
  projectAccessTargets,
  repositoryAccess,
  validGitHubLogin,
} from "./projectAccess";
import { newLocalProjectState, type RepoBinding } from "../model/localState";

vi.mock("./ipc", () => ({ ipc: vi.fn() }));

const mockedIpc = vi.mocked(ipc);

function binding(over: Partial<RepoBinding> = {}): RepoBinding {
  return {
    githubId: "1",
    owner: "dino-admin",
    name: "cluster",
    remoteUrl: "https://github.com/dino-admin/cluster.git",
    branch: "main",
    isPrivate: true,
    hasPages: false,
    ...over,
  };
}

beforeEach(() => mockedIpc.mockReset());

describe("projectAccessTargets", () => {
  it("uses both repositories for private source plus public site", () => {
    const local = {
      ...newLocalProjectState("p", "C:/project", "Cluster"),
      source: binding(),
      delivery: binding({ githubId: "2", name: "cluster-site", isPrivate: false }),
    };
    expect(projectAccessTargets(local).map((target) => target.role)).toEqual([
      "source",
      "delivery",
    ]);
  });

  it("uses one repository for both single-repository topologies", () => {
    for (const topology of ["single-private", "single-public"] as const) {
      const local = {
        ...newLocalProjectState("p", "C:/project", "Cluster"),
        topology,
        source: binding({ isPrivate: topology === "single-private" }),
        delivery: binding({ githubId: "2" }),
      };
      expect(projectAccessTargets(local)).toHaveLength(1);
    }
  });
});

describe("GitHub usernames", () => {
  it("normalizes a pasted handle and refuses unsafe paths", () => {
    expect(normalizeGitHubLogin(" @Dino-Admin ")).toBe("Dino-Admin");
    expect(validGitHubLogin("@Dino-Admin")).toBe(true);
    for (const bad of ["", "-admin", "admin-", "admin/name", "admin@example.com"]) {
      expect(validGitHubLogin(bad), bad).toBe(false);
    }
  });
});

describe("project access IPC", () => {
  it("loads access without exposing a credential", async () => {
    mockedIpc.mockResolvedValue({ collaborators: [] });
    await repositoryAccess("account-9", binding());
    expect(mockedIpc).toHaveBeenCalledWith("github_repository_access", {
      accountId: "account-9",
      owner: "dino-admin",
      repo: "cluster",
    });
  });

  it("invites with a normalized username", async () => {
    mockedIpc.mockResolvedValue({
      status: "invited",
      login: "new-admin",
      permission: "write",
    });
    await inviteRepositoryCollaborator("account-9", binding(), "@new-admin");
    expect(mockedIpc).toHaveBeenCalledWith("github_invite_collaborator", {
      accountId: "account-9",
      owner: "dino-admin",
      repo: "cluster",
      username: "new-admin",
    });
  });
});

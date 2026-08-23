import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.fn();

vi.mock("../ipc", () => ({
  ipc: (...args: unknown[]) => ipc(...args),
}));

import { FEEDBACK_CONFIG } from "../../model/feedback/config";
import { submitReport } from "./api";

beforeEach(() => {
  ipc.mockReset();
});

describe("feedback API payload limits", () => {
  it("refuses a serialized payload over the configured byte limit before IPC", async () => {
    const config = {
      ...FEEDBACK_CONFIG,
      apiBaseUrl: "https://feedback.example.com",
      maxPayloadBytes: 100,
    };
    await expect(
      submitReport(config, { description: "é".repeat(100) } as never),
    ).rejects.toMatchObject({ code: "validation.failed" });
    expect(ipc).not.toHaveBeenCalled();
  });
});

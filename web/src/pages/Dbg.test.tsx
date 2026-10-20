import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ServicesPage } from "./ServicesPage";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
afterEach(() => { vi.unstubAllGlobals(); });
it("dbg type", async () => {
  const svc = { id: "svc_nm", agentId: "ag_1", agentHostname: "h", name: "Jellyfin", candidateId: "c", port: 8096, path: "/Health", expectedStatuses: [200], intervalSeconds: 30, timeoutSeconds: 5, enabled: true, status: "up", lastCheckedAt: "2026-10-19T10:00:30Z", lastStatusCode: 200, lastLatencyMs: 4, consecutiveFailures: 0, upSince: null, processStartedAt: null, availabilityPercent: null, observedSeconds: 0, unknownSeconds: 0, configRevision: 1, failureThreshold: 5, successThreshold: 3 };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/services") return jsonResponse({ services: [svc] });
    if (url === "/api/v1/services/discovered") return jsonResponse({ candidates: [] });
    return jsonResponse({}, 404);
  }));
  const user = userEvent.setup();
  render(<ServicesPage onSessionExpired={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "Edytuj" }));
  const dialog = await screen.findByRole("dialog");
  const nameInput = within(dialog).getByLabelText("Nazwa usługi") as HTMLInputElement;
  console.log("DBG initial:", JSON.stringify(nameInput.value));
  await user.clear(nameInput);
  console.log("DBG after clear:", JSON.stringify(nameInput.value));
  await user.type(nameInput, "Jellyfin (dom)");
  console.log("DBG after type:", JSON.stringify(nameInput.value));
  expect(true).toBe(true);
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["online", "Online"],
    ["stale", "Stale"],
    ["offline", "Offline"],
    ["pending", "Oczekujący"],
    ["revoked", "Odwołany"],
  ] as const)("pokazuje ikonę i TEKST statusu %s (nigdy sam kolor)", (status, label) => {
    const { container } = render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    // Ikona dekoracyjna jest aria-hidden — tekst niesie znaczenie.
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

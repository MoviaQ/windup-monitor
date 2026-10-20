import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MetricSample } from "../types";
import { HistoryChart } from "./HistoryChart";

function sample(at: string, cpu: number | null): MetricSample {
  return {
    sampledAt: at,
    cpuPercent: cpu,
    memoryUsedBytes: 100,
    memoryTotalBytes: 200,
    diskUsedBytes: 10,
    diskTotalBytes: 100,
  };
}

describe("HistoryChart", () => {
  it("pokazuje komunikat zamiast wykresu przy braku próbek", () => {
    render(<HistoryChart samples={[]} />);
    expect(screen.getByText(/Za mało danych do wykresu/)).toBeInTheDocument();
  });

  it("renderuje wykres z rolą img i podsumowaniem dla czytników zamiast widocznej tabeli", () => {
    const samples = [
      sample("2026-10-19T12:00:00Z", 10),
      sample("2026-10-19T12:00:15Z", 25),
      sample("2026-10-19T12:00:30Z", 15),
    ];
    render(<HistoryChart samples={samples} />);
    const chart = screen.getByRole("img", { name: "Historia obciążenia CPU" });
    const summaryId = chart.getAttribute("aria-describedby");
    expect(summaryId).toBeTruthy();
    const summary = summaryId ? document.getElementById(summaryId) : null;
    // Okres z próbek + ostatnia wartość/min/maks; tabela jest całkiem usunięta.
    expect(summary).toHaveTextContent("12:00:00");
    expect(summary).toHaveTextContent("12:00:30");
    expect(summary).toHaveTextContent("15 %");
    expect(summary).toHaveTextContent("10 %");
    expect(summary).toHaveTextContent("25 %");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("pomija próbki bez wartości CPU", () => {
    const samples = [sample("2026-10-19T12:00:00Z", null), sample("2026-10-19T12:00:15Z", 20)];
    render(<HistoryChart samples={samples} />);
    expect(screen.getByText(/Za mało danych do wykresu/)).toBeInTheDocument();
  });
});

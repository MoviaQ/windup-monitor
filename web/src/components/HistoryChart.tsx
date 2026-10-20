import { useId, useMemo } from "react";
import type { MetricSample } from "../types";
import { formatDateTime, formatPercent, ratioPercent } from "../utils/format";

const MAX_POINTS = 48;
const MIN_POINTS = 2;

/**
 * Wykres historii CPU jako SVG. Bez widocznej tabeli: podsumowanie okresu
 * (od–do, ostatnia wartość, min/maks) jest tekstem tylko dla czytników ekranu
 * i opisuje wykres przez aria-describedby (ui-design §8 bez widocznej kontrolki).
 */
export function HistoryChart({ samples }: { samples: MetricSample[] }): React.JSX.Element {
  const summaryId = useId();
  const points = useMemo(() => {
    const ordered = [...samples]
      .filter((sample) => Number.isFinite(Date.parse(sample.sampledAt)))
      .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt))
      .slice(-MAX_POINTS);
    return ordered
      .map((sample) => ({
        at: sample.sampledAt,
        cpu: typeof sample.cpuPercent === "number" && Number.isFinite(sample.cpuPercent) ? sample.cpuPercent : null,
        mem: ratioPercent(sample.memoryUsedBytes, sample.memoryTotalBytes),
        disk: ratioPercent(sample.diskUsedBytes, sample.diskTotalBytes),
      }))
      .filter((point) => point.cpu !== null);
  }, [samples]);

  if (points.length < MIN_POINTS) {
    return <p className="age-text">Za mało danych do wykresu — próbki pojawią się po kilku heartbeatach agenta.</p>;
  }

  const width = 480;
  const height = 160;
  const pad = 8;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const path = points
    .map((point, index) => {
      const x = pad + index * step;
      const y = height - pad - (Math.min(100, Math.max(0, point.cpu ?? 0)) / 100) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const cpuValues = points.map((point) => point.cpu).filter((value): value is number => value !== null);
  const lastCpu = cpuValues[cpuValues.length - 1];
  const minCpu = Math.min(...cpuValues);
  const maxCpu = Math.max(...cpuValues);
  const firstTime = points[0].at;
  const lastTime = points[points.length - 1].at;
  // Podsumowanie dla czytników ekranu zamiast widocznej tabeli.
  const summary =
    `Okres: od ${formatDateTime(firstTime)} do ${formatDateTime(lastTime)}. ` +
    `Ostatnia wartość CPU ${formatPercent(lastCpu)}, ` +
    `min ${formatPercent(minCpu)}, maks ${formatPercent(maxCpu)}.`;

  return (
    <div>
      <svg
        className="history-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Historia obciążenia CPU"
        aria-describedby={summaryId}
      >
        <path d={path} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
      <p id={summaryId} className="visually-hidden">{summary}</p>
    </div>
  );
}

import { AnimatedValue } from "@/components/animated-value";
import { Pending } from "@/components/toolkit";
import { t } from "@/i18n";
import type { ProbeResult } from "@/views/link/api";
import { NumberTicker } from "./number-ticker";

/**
 * Latency is an instrument readout: the tone is a state, not a color computed
 * here. `data-state` maps to the ink tokens in app.css, which keeps the value
 * legible in both appearances and lets CSS handle the transition instead of a
 * GSAP color tween.
 */
function latencyState(
  result: ProbeResult | undefined,
  running: boolean,
): "good" | "ok" | "warn" | "bad" | undefined {
  const latency = result?.median;
  if (latency == null || latency < 0)
    return running && !result?.samples.length ? undefined : "bad";
  if (latency < 100) return "good";
  if (latency < 400) return "ok";
  // Slow stays amber; red is reserved for a failure, so a slow median is never
  // mistaken for an unreachable host.
  return "warn";
}

export function LatencyBadge({
  result,
  running,
}: {
  result?: ProbeResult;
  running: boolean;
}) {
  const latency = result?.median;
  const pending = running && !result?.samples.length;
  return (
    <span
      data-state={pending ? undefined : latencyState(result, running)}
      className="ping-ms latency-badge"
      title={t(
        "浏览器 HTTP 请求耗时中位数；颜色与显示的中位数一致，非 ICMP 延迟",
      )}
    >
      <AnimatedValue value={pending}>
        {pending ? (
          <Pending>···</Pending>
        ) : latency != null && latency >= 0 ? (
          <>
            <NumberTicker value={latency} />
            ms
          </>
        ) : (
          <span>{result?.samples.length ? t("未连通") : "—"}</span>
        )}
      </AnimatedValue>
    </span>
  );
}

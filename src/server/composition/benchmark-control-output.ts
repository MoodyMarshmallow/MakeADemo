import { writeSync } from "node:fs";

import type { AgentTaskEvent } from "../agent-harness/agent-session-runner.interface";
import {
  readBenchmarkProviderRetryControlEvent,
  serializeBenchmarkDaytonaProvisioningSucceededControlEvent,
  serializeBenchmarkProviderRetryControlEvent,
} from "../shared/benchmark/benchmark-control-events.schema";

/**
 * Emits benchmark-only control feedback over the parent-provided fd3 channel.
 * It is deliberately fail-open: Pipeline execution never depends on this
 * observational feedback path.
 */
export function createBenchmarkControlOutput(options: {
  fd?: 3;
  now?: () => string;
  write?: (line: string) => void;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  let enabled = true;
  let provisioningSucceededEmitted = false;
  let write = options.write;
  if (write === undefined && options.fd === 3) {
    try {
      write = (line) => {
        writeSync(3, line, undefined, "utf8");
      };
    } catch {
      enabled = false;
    }
  }

  return {
    onPipelineProgress(event: {
      stage: string;
      status: string;
    }): void {
      if (
        !enabled ||
        provisioningSucceededEmitted ||
        event.stage !== "repo-security-screen" ||
        event.status !== "succeeded"
      )
        return;
      provisioningSucceededEmitted = true;
      try {
        write?.(
          `${serializeBenchmarkDaytonaProvisioningSucceededControlEvent({ occurredAt: now() })}\n`,
        );
      } catch {
        enabled = false;
      }
    },
    onAgentEvent(event: AgentTaskEvent): void {
      if (!enabled || event.kind !== "audit") return;
      const controlEvent = readBenchmarkProviderRetryControlEvent({
        event: event.event,
        metadata: event.metadata,
        occurredAt: now(),
      });
      if (controlEvent === undefined) return;
      try {
        write?.(
          `${serializeBenchmarkProviderRetryControlEvent(controlEvent)}\n`,
        );
      } catch {
        enabled = false;
      }
    },
  };
}

import type { RestorePhase } from "../api/client";

export type RestoreState = {
  phase: RestorePhase;
  history: RestorePhase[];
  error?: string;
  retry?: () => void;
};

export function RestoreProgress({ state }: { state: RestoreState }) {
  return (
    <section className="restore-progress" aria-live="polite" aria-label="Restore progress">
      <ol>
        {state.history.map((phase, index) => (
          <li key={`${phase}-${index}`} aria-current={phase === state.phase ? "step" : undefined}>
            {phase}
          </li>
        ))}
      </ol>
      {state.phase === "FAILED" ? (
        <div className="restore-failure">
          <p role="alert">{state.error ?? "RESTORE FAILED"}</p>
          {state.retry ? (
            <button type="button" aria-label="Retry" onClick={state.retry}>RETRY</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

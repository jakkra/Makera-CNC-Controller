export const JOG_PREDICTION_TOLERANCE_MM = 0.02;

export function createMachineReconciliation({
  getState = () => ({}),
  performanceRef = globalThis.performance,
  axisValue = (values, axis) => {
    const value = Number(values?.[axis]);
    return Number.isFinite(value) ? value : null;
  },
  toleranceMM = JOG_PREDICTION_TOLERANCE_MM,
} = {}) {
  const state = getState();

  function jogMotionAwaitingSettlement() {
    return !!state.jog.motionRevisionKnown &&
      Number(state.jog.motionRevision || 0) > Number(state.jog.settledMotionRevision || 0);
  }

  function jogEstimateActive() {
    return !!state.jog.estimated &&
      (jogMotionAwaitingSettlement() || Number(state.jog.estimatedUntil) > performanceRef.now());
  }

  function mergeMachineStatusForDisplay(next) {
    if (!jogEstimateActive()) return next;
    return {
      ...next,
      mpos: state.machine.mpos,
      wpos: state.machine.wpos,
      motion_estimated: !!state.machine.motion_estimated,
    };
  }

  function shouldPreserveJogPrediction(next) {
    if (!next?.mpos || !jogEstimateActive()) return false;
    if (state.jog.motionRevisionKnown && !jogMotionAwaitingSettlement()) return false;
    if (next.state && next.state !== "Idle" && next.state !== "Run") return false;
    const predicted = state.jog.mpos;
    if (!predicted) return false;
    const target = state.jog.target || predicted;
    let predictionIsAhead = false;
    for (const axis of ["x", "y", "z"]) {
      const observedAxis = axisValue(next.mpos, axis);
      const predictedAxis = axisValue(predicted, axis);
      if (observedAxis === null || predictedAxis === null) continue;
      if (Math.abs(predictedAxis - observedAxis) <= toleranceMM) continue;
      const targetAxis = axisValue(target, axis);
      if (targetAxis === null) {
        predictionIsAhead = true;
        continue;
      }
      const predictedRemaining = targetAxis - predictedAxis;
      const observedRemaining = targetAxis - observedAxis;
      const sameApproachSide = Math.abs(predictedRemaining) <= toleranceMM ||
        Math.sign(observedRemaining) === Math.sign(predictedRemaining);
      if (sameApproachSide && Math.abs(observedRemaining) > Math.abs(predictedRemaining) + toleranceMM) {
        predictionIsAhead = true;
      }
    }
    return predictionIsAhead;
  }

  function reconcileObservedMachineStatus(next) {
    if (!next) return next;
    state.jog.observed = next.mpos || state.jog.observed;
    if (next.mpos && !shouldPreserveJogPrediction(next)) {
      state.jog.mpos = next.mpos;
      state.jog.wpos = next.wpos || state.jog.wpos;
      state.jog.estimated = false;
      state.jog.estimatedUntil = 0;
    }
    return mergeMachineStatusForDisplay(next);
  }

  return {
    jogMotionAwaitingSettlement,
    jogEstimateActive,
    mergeMachineStatusForDisplay,
    shouldPreserveJogPrediction,
    reconcileObservedMachineStatus,
  };
}

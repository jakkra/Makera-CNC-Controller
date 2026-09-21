// Work-area pointer interaction and the touch jog state machine.  The module
// owns only interaction state; machine I/O and work-area/probe policy remain
// in the injected callbacks so extraction cannot change their contracts.

export function mobileWorkAreaJogEnabled(windowRef = globalThis, maxWidth = 600) {
  return typeof windowRef !== "undefined" && Number(windowRef?.innerWidth) <= maxWidth;
}

export function mobileJogAxisForResponse(value, clampAxis = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)), deadzone = 0.12) {
  value = clampAxis(value);
  if (Math.abs(value) < 1e-6) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * (deadzone + (1 - deadzone) * Math.cbrt(Math.abs(value)));
}

export function mobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX, clampAxis, deadzone = 0.12) {
  const radius = Math.max(1, Number(radiusPX) || 1);
  const dx = Number(clientX) - Number(originX);
  const dy = Number(clientY) - Number(originY);
  const distance = Math.hypot(dx, dy);
  const scale = distance > radius ? radius / distance : 1;
  return {
    x: mobileJogAxisForResponse((dx * scale) / radius, clampAxis, deadzone),
    y: mobileJogAxisForResponse((-dy * scale) / radius, clampAxis, deadzone),
    z: 0,
  };
}

export function mobileWorkAreaJogRadius(svg, clampNumber = (value, min, max) => Math.max(min, Math.min(max, value)), minRadius = 56, maxRadius = 88) {
  const rect = svg?.getBoundingClientRect?.();
  const size = Math.min(Number(rect?.width) || 0, Number(rect?.height) || 0);
  return clampNumber(size * 0.22, minRadius, maxRadius);
}

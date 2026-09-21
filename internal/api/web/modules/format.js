export function fmtCoord(v) {
  return Number.isFinite(v) ? v.toFixed(3) : "-";
}

export function fmtPos(p, estimated = false) {
  if (!p) return "-";
  return `X ${fmtCoord(p.x)} Y ${fmtCoord(p.y)} Z ${fmtCoord(p.z)}${estimated ? " est" : ""}`;
}

export function fmtTime(s) {
  if (!s || s.startsWith("0001-")) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtSize(n, isDir) {
  if (isDir) return "-";
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return "now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m";
  return Math.round(min / 60) + "h";
}

export function fmtActiveFeed(f) {
  const cur = Number(f?.current);
  if (!Number.isFinite(cur)) return "-";
  const value = Math.abs(cur) >= 100 ? Math.round(cur).toString() : cur.toFixed(1);
  return value + " mm/min";
}

export function fmtSpindle(s) {
  if (!s) return "-";
  const cur = Number.isFinite(s.current_rpm) ? Math.round(s.current_rpm) : "-";
  const target = Number.isFinite(s.target_rpm) ? Math.round(s.target_rpm) : "-";
  const over = Number.isFinite(s.override) ? Math.round(s.override) + "%" : "-";
  return `${cur}/${target} rpm ${over}`;
}

export function fmtDashboardFeed(f) {
  if (!f) return { current: "-", detail: "-" };
  const current = Number(f.current);
  const target = Number(f.target);
  const override = Number(f.override);
  return {
    current: Number.isFinite(current) ? `${Math.round(current)} mm/min` : "-",
    detail: `${Number.isFinite(target) ? "Target " + Math.round(target) : "Target -"} · ${Number.isFinite(override) ? Math.round(override) + "%" : "-"}`,
  };
}

export function fmtDashboardSpindle(s) {
  if (!s) return { current: "-", detail: "-" };
  const current = Number(s.current_rpm);
  const target = Number(s.target_rpm);
  const override = Number(s.override);
  return {
    current: Number.isFinite(current) ? `${Math.round(current)} rpm` : "-",
    detail: `${Number.isFinite(target) ? "Target " + Math.round(target) : "Target -"} · ${Number.isFinite(override) ? Math.round(override) + "%" : "-"}`,
  };
}

export function fmtTemperature(value, label) {
  const number = Number(value);
  return Number.isFinite(number) ? `${label} ${number.toFixed(1)} °C` : `${label} -`;
}

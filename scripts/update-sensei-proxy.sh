#!/usr/bin/env bash
# Build and atomically install the local Sensei proxy after tests pass.
#
# Development happens in the repository while the installed service keeps
# running. Invoke this script only for a deliberate local release; it keeps one
# known-good binary and restores it automatically if the restarted API fails
# its localhost health check.
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
binary_path="${HOME}/.local/bin/sensei-cnc-proxy"
release_dir="${HOME}/.local/share/sensei/releases"
previous_path="${release_dir}/sensei-cnc-proxy.previous"
go_bin=$(command -v go || true)
if [[ -z "$go_bin" && -x /usr/local/go/bin/go ]]; then
  go_bin=/usr/local/go/bin/go
fi

if [[ ! -x "$binary_path" ]]; then
  printf 'Sensei binary is missing: %s\n' "$binary_path" >&2
  exit 1
fi
if [[ -z "$go_bin" ]]; then
  printf 'Go is not available in PATH or /usr/local/go/bin/go.\n' >&2
  exit 1
fi

mkdir -p "$release_dir"
candidate_path=$(mktemp "${release_dir}/sensei-cnc-proxy.candidate.XXXXXX")
trap 'rm -f "$candidate_path"' EXIT

cd "$repo_dir"
"$go_bin" build -mod=mod -o "$candidate_path" ./cmd/proxy
install -m 0755 "$binary_path" "$previous_path"
install -m 0755 "$candidate_path" "$binary_path"
systemctl --user restart sensei-cnc-proxy

for _ in {1..10}; do
  if curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8420/api/machine; then
    printf 'Sensei update installed and healthy. Previous binary: %s\n' "$previous_path"
    exit 0
  fi
  sleep 1
done

printf 'Sensei health check failed; restoring previous binary.\n' >&2
install -m 0755 "$previous_path" "$binary_path"
systemctl --user restart sensei-cnc-proxy
exit 1

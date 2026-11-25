#!/usr/bin/env bash
# Prints the CHANGELOG.md section for a version: from its "## <version>" heading (also
# "## v<version>" or "## [<version>]", with anything after it) to the next "## " heading.
# Prints nothing when there is no such section.
set -euo pipefail
version=${1:?usage: release-notes.sh <version> [changelog]}
file=${2:-CHANGELOG.md}
awk -v v="$version" '
  BEGIN { esc = v; gsub(/\./, "\\.", esc); head = "^## \\[?v?" esc "\\]?([^0-9.].*)?$" }
  /^## / { if (inside) exit; if ($0 ~ head) { inside = 1; next } }
  inside { print }
' "$file" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'

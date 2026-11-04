#!/bin/bash
# Builds release/NEXUS-AI-<version>-<arch>.dmg from the packaged .app.
# Uses hdiutil directly: the volume is excluded from Spotlight and busy detaches are retried,
# which avoids dmgbuild's "Resource busy" failures on machines with endpoint scanners.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")

for volume in /Volumes/NEXUS\ AI*; do
  [ -d "$volume" ] && hdiutil detach "$volume" -force >/dev/null 2>&1 || true
done

built=0
for dir in release/mac-arm64 release/mac release/mac-universal; do
  app="$dir/NEXUS AI.app"
  [ -d "$app" ] || continue
  case "$dir" in *arm64) arch=arm64 ;; *universal) arch=universal ;; *) arch=x64 ;; esac
  out="release/NEXUS-AI-$VERSION-$arch.dmg"
  stage=$(mktemp -d)
  ditto "$app" "$stage/NEXUS AI.app"
  ln -s /Applications "$stage/Applications"
  touch "$stage/.metadata_never_index"
  rm -f "$out"
  for attempt in 1 2 3 4 5; do
    if hdiutil create -volname "NEXUS AI" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$out" >/dev/null; then
      echo "  • dmg  $out"
      built=$((built + 1))
      break
    fi
    if [ "$attempt" -eq 5 ]; then rm -rf "$stage"; echo "  ⨯ hdiutil failed for $out" >&2; exit 1; fi
    echo "  • hdiutil busy, retrying ($attempt/5)…"
    sleep 3
  done
  rm -rf "$stage"
done

[ "$built" -gt 0 ] || { echo "  ⨯ no packaged NEXUS AI.app found under release/" >&2; exit 1; }

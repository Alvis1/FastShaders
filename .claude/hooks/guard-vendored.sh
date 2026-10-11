#!/usr/bin/env bash
# PreToolUse hook: generated files are never edited.
#
# scripts/sync-generated.mjs (the `fs-vendor-sync` vite plugin, at every
# dev/build/test start) writes public/js/ and ShaderCarousel/components/three/
# from a-frame-shaderloader/js/ (the git submodule and the jsdelivr CDN source),
# ShaderCarousel/lib/three/ from the installed three, and
# public/models/teapot.obj from src/engine/teapotGeometry.ts. It OWNS the three
# folders (a file its tables do not name is pruned) and all four are gitignored,
# so a hand edit there is silently overwritten at the next start and git never
# shows it. vendorSync.test.ts runs AFTER that sync, so it cannot catch one.
#
# Edit/Write/MultiEdit on those paths: DENY (certain).
# Bash commands that look like they write there: ASK (heuristic — a read such
# as `cp public/js/x /tmp` would also match, so the user decides).
set -u

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')

# Every path scripts/sync-generated.mjs writes (its OWNED_DIRS + TEAPOT_OBJ).
# The boundary is "not part of a longer name": a `/` in an absolute path, a
# space or quote in a shell command.
GENERATED='(public/js/|ShaderCarousel/components/three/|ShaderCarousel/lib/three/|public/models/teapot\.obj)'
VENDORED_RE="(^|[^A-Za-z0-9_.-])$GENERATED"
REASON='Generated file — scripts/sync-generated.mjs (the vite fs-vendor-sync plugin) rewrites it at every dev/build/test start and prunes what its tables do not name, so a hand edit is silently lost. Edit the SOURCE: a-frame-shaderloader/js/ (the submodule) for public/js/ and the carousel A-Frame bundle, the installed three for ShaderCarousel/lib/three/, src/engine/teapotGeometry.ts + teapotData.ts for public/models/teapot.obj. Loaders 0.4/0.5/0.6 are FROZEN; new work goes in 0.8, additively.'

decide() {
  jq -n --arg d "$1" --arg r "$REASON" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
    printf '%s' "$path" | grep -Eq "$VENDORED_RE" && decide deny
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
    if printf '%s' "$cmd" | grep -Eq "$VENDORED_RE"; then
      if printf '%s' "$cmd" | grep -Eq "(sed|perl)[[:space:]]+-[a-zA-Z]*i|>[[:space:]]*[^[:space:]]*$GENERATED|(^|[^a-z])(tee|cp|mv|rm|rsync|install)[[:space:]]|\\.write|writeFile"; then
        decide ask
      fi
    fi
    ;;
esac
exit 0

#!/usr/bin/env bash
# Fails (exit 1) if any of the given images — or directories — carries a secret.
#
#   scripts/scan-image-secrets.sh IMAGE [IMAGE...]
#   SCAN_SECRET_VALUES=... scripts/scan-image-secrets.sh --dir DIR [DIR...]
#
# The images are published to GHCR and meant to go public, so anything baked in
# is published with them. Three places a secret can hide, all checked:
#   - Config.Env      (an ENV / ARG→ENV in a Dockerfile)
#   - docker history  (a RUN line that echoed a build arg)
#   - every layer     (a COPY that picked up .env, a key, a service account).
#     Each layer separately, from `docker save`: a file deleted by a later layer
#     is invisible in the container but still downloadable from the registry.
# CANARY_SECRET is what images.yml puts in every .env value, so a compose build
# arg that forwards a .env variable shows up here by name.
#
# --dir runs the same name and content patterns over a build output that reaches
# every user without being an image: the web `dist/` (deploy.yml) and the mobile
# OTA bundle (mobile-ota.yml). Those builds saw REAL values, not canaries, so
# SCAN_SECRET_VALUES (newline-separated) lists the values that must never appear.
# A hit prints the file, never the value.
set -euo pipefail

# Tokens. Precise shapes, not "sk-" plus anything: CoreLib's culture table contains
# "sk-sksl-sisma-…" and libunistring "AKIAISLANDISSHARITAL".
CONTENT='CANARY_SECRET|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}([^A-Za-z0-9]|$)|sk-[A-Za-z0-9_-]*T3BlbkFJ|sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{40,}'
# A private key is the header followed by key material. The header alone is a
# string literal in every TLS library (node, chromium, gnutls…).
PEM='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{40}'
# Files whose mere presence is a finding. .env.example is documentation.
NAMES='(^|/)(\.env(\.[^/]*)?|[^/]*service-account[^/]*\.json|appsettings\.[^/]*\.json|id_(rsa|ed25519|ecdsa)|[^/]*\.(p12|pfx|jks|keystore))$'
# Known public files that match anyway (path regex). Keep it short; say why.
#   - libgnutls (distro package) embeds a PEM key literal for its self-tests.
ALLOW='^(etc/ssl/|usr/share/ca-certificates/)|\.env\.example$|^usr/lib/([a-z0-9_]+-linux-gnu/)?libgnutls\.so'
# Where everything is searched: a throwaway Linux container, so a CI runner, the
# server and a Mac run the same GNU grep (BSD grep took minutes per image) and
# nothing from an image is unpacked onto the host. Debian slim, not alpine: its
# grep is already GNU with PCRE, so a scan needs no `apk add` (no package mirror on
# the deploy path). Pinned by digest; Dependabot cannot see a pin in a script, so
# bump it by hand: docker buildx imagetools inspect debian:13-slim.
SCANNER=debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# The search, shared by both modes. Runs in $SCANNER from the directory to search;
# prints "<path>\t<why>" per finding.
SEARCH=$(cat <<'SH'
# grep: 0 = match, 1 = none, 2 = broken. A broken search must not read as clean.
search() { why=$1; shift; rc=0; grep "$@" > /tmp/hit || rc=$?
  [ "$rc" -le 1 ] || { echo "SCAN-ERROR $why"; exit 1; }
  awk -v w="$why" '{print $0 "\t" w}' /tmp/hit; }
find . -type f > /tmp/files
{ search name -E -e "$NAMES" /tmp/files
  search token -rlaE -e "$CONTENT" .
  search 'private key' -rlaPz -e "$PEM" .
  if [ -s /vals ]; then search 'secret value' -rlaF -f /vals .; fi
} | sed 's#^\./##'
SH
)

# Image mode: `docker save` on stdin, every layer unpacked into its own dir.
# Prints "<path>\t<why>, layer <id>" per finding, then COUNT=<layers>.
LAYERS=$(cat <<'SH'
mkdir /s /x && tar -x -C /s
n=0
for b in $(find /s -type f); do
  d=/x/$(basename "$b" | cut -c1-12)
  mkdir -p "$d"
  if tar -tf "$b" >/dev/null 2>&1; then tar -x -C "$d" -f "$b" 2>/dev/null || true; n=$((n+1))
  elif gzip -t "$b" 2>/dev/null; then gzip -dc "$b" | tar -x -C "$d" 2>/dev/null || true; n=$((n+1))
  else cp "$b" "$d/"; fi   # config / manifest JSON: searched as a file
done
cd /x
search_all | awk -F'\t' '{ i = index($1, "/"); print substr($1, i + 1) "\t" $2 ", layer " substr($1, 1, i - 1) }'
echo "COUNT=$n"
SH
)

# Dir mode: the directory is mounted read-only at /x. COUNT = files searched.
DIR=$(cat <<'SH'
cd /x
search_all
echo "COUNT=$(wc -l < /tmp/files)"
SH
)

inner() { printf 'set -eu\nsearch_all() {\n%s\n}\n%s\n' "$SEARCH" "$1"; }

# $1 = what was scanned, $2 = what COUNT counts; scanner output on stdin.
report() {
  local out count hits
  out=$(cat)
  count=$(printf '%s\n' "$out" | sed -n 's/^COUNT=//p')
  # A scan that saw nothing must not read as clean.
  [ "${count:-0}" -gt 0 ] || { echo "::error::$1: no $2 found to scan"; return 1; }
  if printf '%s\n' "$out" | grep -q 'SCAN-ERROR'; then echo "::error::$1: grep failed in the scanner"; return 1; fi
  hits=$(printf '%s\n' "$out" | { grep -v '^COUNT=' || true; } \
    | ALLOW="$ALLOW" awk -F'\t' 'NF > 1 && $1 !~ ENVIRON["ALLOW"] { print "  " $1 "  (" $2 ")" }' | sort -u)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "::error::$1: secret-like content"; return 1
  fi
  echo "  clean ($count $2)"
}

fail=0
if [ "${1:-}" = "--dir" ]; then
  shift
  # One value per line. Blank and short lines dropped: an empty pattern in
  # `grep -F -f` matches every file.
  vals=$(mktemp); trap 'rm -f "$vals"' EXIT; chmod 600 "$vals"
  printf '%s\n' "${SCAN_SECRET_VALUES:-}" | awk 'length($0) >= 8' > "$vals"
  for dir in "$@"; do
    abs=$(cd "$dir" && pwd)
    echo "== $abs ($(wc -l < "$vals" | tr -d ' ') secret values)"
    docker run --rm -v "$abs:/x:ro" -v "$vals:/vals:ro" \
      -e CONTENT="$CONTENT" -e PEM="$PEM" -e NAMES="$NAMES" "$SCANNER" sh -c "$(inner "$DIR")" \
      | report "$abs" files || fail=1
  done
  exit $fail
fi

for img in "$@"; do
  echo "== $img"
  if docker image inspect "$img" --format '{{json .Config.Env}}' | grep -Eo "$CONTENT"; then
    echo "::error::$img: secret pattern in Config.Env"; fail=1
  fi
  if docker history --no-trunc --format '{{.CreatedBy}}' "$img" | grep -Eo "$CONTENT"; then
    echo "::error::$img: secret pattern in layer history"; fail=1
  fi
  docker save "$img" \
    | docker run --rm -i -e CONTENT="$CONTENT" -e PEM="$PEM" -e NAMES="$NAMES" "$SCANNER" sh -c "$(inner "$LAYERS")" \
    | report "$img" layers || fail=1
done
exit $fail

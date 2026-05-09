#!/bin/bash
# Build, sign, and notarize the touchid-trigger CLI for distribution.
#
# Prereqs (one-time):
#   1. Developer ID Application certificate in your login keychain.
#   2. notarytool credentials stored under a keychain profile, e.g.:
#        xcrun notarytool store-credentials touchid-trigger \
#          --apple-id you@example.com --team-id X44L3QQYVR \
#          --password <app-specific-password>
#
# Usage:
#   ./release.sh v0.1.0
#
# Env overrides:
#   SIGN_IDENTITY    full codesign identity string
#   NOTARY_PROFILE   notarytool keychain profile name (default: touchid-trigger)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <version>   e.g. $(basename "$0") v0.1.0" >&2
  exit 1
fi

cd "$(dirname "$0")"

VERSION="$1"
BINARY="touchid-trigger"
ZIP="${BINARY}-${VERSION}.zip"
IDENTITY="${SIGN_IDENTITY:-Developer ID Application: Leonard Tan (X44L3QQYVR)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-touchid-trigger}"

echo "=== Building universal binary (arm64 + amd64) ==="
CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 CC="clang -arch arm64" \
  go build -trimpath -o "${BINARY}-arm64" .
CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 CC="clang -arch x86_64" \
  go build -trimpath -o "${BINARY}-amd64" .
lipo -create -output "${BINARY}" "${BINARY}-arm64" "${BINARY}-amd64"
rm -f "${BINARY}-arm64" "${BINARY}-amd64"

echo "=== Signing with hardened runtime ==="
codesign --force --options runtime --timestamp \
  --sign "${IDENTITY}" --entitlements entitlements.plist "${BINARY}"
codesign --verify --strict --verbose=2 "${BINARY}"

echo "=== Packaging for notarization ==="
rm -f "${ZIP}"
ditto -c -k --keepParent "${BINARY}" "${ZIP}"

echo "=== Submitting to Apple notary (profile: ${NOTARY_PROFILE}) ==="
xcrun notarytool submit "${ZIP}" --keychain-profile "${NOTARY_PROFILE}" --wait

# Bare Mach-O CLI binaries cannot be stapled. The notarization ticket is
# stored with Apple; Gatekeeper performs a one-time online check on first
# launch when the file carries a quarantine xattr (i.e. browser-downloaded).
# For non-quarantined channels (npm, curl, git, tar, brew) it just runs.
echo "=== Repackaging final zip ==="
rm -f "${ZIP}"
ditto -c -k --keepParent "${BINARY}" "${ZIP}"

echo
echo "=== Done ==="
echo "Signed binary: $(pwd)/${BINARY}"
echo "Distribution:  $(pwd)/${ZIP}"

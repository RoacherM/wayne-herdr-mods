#!/bin/sh
# Build the native shell and install it on the iPhone (USB, or the same Wi-Fi once paired in Xcode).
# A free Apple ID works: the app then runs for 7 days; run this again to renew it.
#   shell/ios/install.sh [device name or id]     (default: the first physical iPhone)
set -eu
cd "$(dirname "$0")"
# The team: the OU of the Apple Development certificate in the keychain (or TEAM=… to choose).
TEAM=${TEAM:-$(security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject 2>/dev/null | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p' | head -1)}
BUNDLE_ID=${BUNDLE_ID:-com.roacherm.herdr-relay}
export TEAM BUNDLE_ID
xcodegen generate --spec project.yml --quiet
xcodebuild -project HerdrRelay.xcodeproj -scheme HerdrRelay -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build -allowProvisioningUpdates -quiet build
APP=build/Build/Products/Release-iphoneos/HerdrRelay.app
DEVICE=${1:-$(xcrun devicectl list devices --hide-default-columns --columns Identifier --filter "Platform == 'iOS' AND Reality == 'physical'" 2>/dev/null | awk 'NR==3{print $1}')}
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" || echo "装好了。第一次打开前：设置 ▸ 通用 ▸ VPN 与设备管理 ▸ 信任开发者。"

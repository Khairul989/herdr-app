# Physical iPhone video transport

Adapted from Expo Device Hub PR #507 at a03b9e9266be5589587e384c8bf6659e6fa496ca:
https://github.com/expo/expo-device-hub/pull/507

The optional build fetches the MIT-licensed Callstack codex-mobile-dev-plugin at
7ea9a42c713117464a36c2f4ebde424b13059bb7, packages/native/ios-mirror, with its
published SHA-256 checksum. The unchanged Expo patch removes telemetry, renames
the crate, crops encoder padding, and maps touch coordinates for orientation.

The transport also derives from jkcoxson/idevice at
a64b8867815b3da17b5c927531bdba877e8456ef and JaviSoto/device-hub-ios at
1fcdfb0a6799b62f05625d0cbb359bec57256b94. See the adjacent license files.
Native dependency licenses are collected into THIRD-PARTY-LICENSES.txt at build.

This experimental adapter uses private CoreDevice display and UniversalHID
services. It requires Apple Silicon, Xcode 27+, trusted pairing, Developer Mode,
and an HEVC-capable browser. It is independent of the stable simulator/Android
hub and the existing XCTest agent automation. No telemetry is included.

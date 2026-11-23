# Devices: simulator input, video stalls and headless startup

Incident: 18 November 2026. Changes are on `fix/simulator-agent-input`.
This is a debugging map and a record of observed behavior, not a release notice.

## Symptoms and where to look

| Symptom | Starting point | Finding and fix |
| --- | --- | --- |
| First simulator click hangs for minutes | `defaults/mods/devices/interaction.mjs`: `simulatorInput`, `simulatorInspect`; `agent.mjs`: `drive` | Backend input entered an XCTest runner path. The observed `xcodebuild` was `test-without-building`, so the original report's suspected compilation was actually runner startup. Local simulator click/press/type now use native SimHID and accessibility keyboard input; snapshots and refs use native accessibility inspection. Physical iPhone runner behavior is separate. |
| Later commands say another command holds the session | `agent.mjs`: `commandLock`, `watchCaller`, `execute`, `drive` | An orphan could retain `device-panels/<session>/agent.lock`. Locks now atomically record an owner PID, serialize dead-owner recovery, and release in cleanup. Caller loss aborts work; subprocesses have timeouts. A live owner must still exclude another command. |
| Expired ref after a failed or interrupted action | `interaction.mjs`: `simulatorInspect`; `agent.mjs`: `drive` | Refs belong to a snapshot frame, not permanently to a control. Refresh the snapshot after reconnects or uncertain input. Do not infer that an expired ref proves input landed, and do not replay an uncertain action automatically. |
| Viewer stays Live but video stops or goes black | `stream-client.js`; `stream-proxy.mjs`; `live.mjs`: `serveLive` | Holding the real AVCC fetch reproduced stopped painted frames without a reconnect. Recovery now watches actual canvas paints, retains the last frame, reconnects the viewer and replaces failed or persistently stalled owned capture workers. |
| Snapshot disrupts live capture | `interaction.mjs`: shared capture lookup; `live.mjs`: `registerLive` | Multiple native capture owners can compete. Agent screenshots now use the registered live owner's screenshot endpoint, checking its PID, device, platform, loopback URL and PNG signature. A one-off native capture is used when no live owner exists. This contention is a risk addressed by the change, not a proven explanation for every original black screen. |
| DeviceHub/Simulator window opens during connection | `device.js`: `bootInBackground`; `live.mjs`: `hubArgs` | Backend cold boot calls `open -g -a Simulator`; the standalone serve-sim path can explicitly launch DeviceHub. Preboot iOS with `simctl boot` and `bootstatus` before backend open, and keep the pinned single-device middleware path. A background GUI launch is still a GUI launch. |
| Installed fix appears to disappear | `build.rs` embedded defaults; installed app versus live mod files | Herdr installs embedded shipped mods at startup. Copying source into the live config alone is insufficient if the next launch embeds older files. Check the signed executable, embedded payload and config copies together; reopen Herdr to replace already loaded worker code. |

## Expected behavior

The viewer remains a continuous video stream. The retained frame is only a
reconnection overlay, not a screenshot polling replacement. The client detects
missing paints after roughly 3.5 seconds (12 seconds for an initial frame).
Visible stale health reports can trigger worker replacement after 10 seconds,
with a 15-second recovery cooldown. These are detection thresholds, not a
recovery-time guarantee; the forced unresponsive-host probe took about 25
seconds overall. Hidden viewers do not initiate visible-stall recovery.

The proxy origin remains stable across capture-child restarts. Recovery never
replays input, restarts the device app, or reboots the simulator. Restart video
replaces the stream only. Disconnect closes the helper app session and leaves
the simulator running. Shutting down the simulator is a separate explicit action.

## Debugging sequence

1. Check the installed executable and current process before changing anything.
   `Herdr --version` can be identical across local builds; compare executable
   hashes and the running executable inode, not just the version string.
2. Inspect the process tree for the exact device and session. Distinguish
   `xcodebuild test-without-building` from an actual build. Check lock owner PID
   liveness before recovery; never remove a lock held by a live command.
3. Read the matching registration under
   `~/.config/herdr-app/device-tools/live/<platform>-<device>-<pid>.json`.
   Its loopback URL exposes `/_herdr/stream-health`, including client painted
   frames, frame age, visibility and user agent. Compare successive reports
   from the same page; a loaded page or successful screenshot does not prove
   video is advancing. Check native WKWebView evidence separately from Chrome.
4. Obtain a fresh snapshot and use its current ref. Coordinate input with the
   person and other agents. Do not retry a financial or other consequential
   action merely because the caller timed out.
5. If video still fails, use Restart video and capture health/process evidence.
   Avoid another capture owner, broad process kills, simulator reboot or Core
   restart as a default remedy. Reproduce fault injection only against an
   isolated owned capture process.

Example helper flow, using an already installed app (substitute exact IDs):

```sh
node ~/.config/herdr-app/mods/devices/agent.mjs open --device DEVICE_UDID --app APP_BUNDLE_ID
node ~/.config/herdr-app/mods/devices/agent.mjs run current snapshot -i --compact
# Replace @e1 with the desired control's ref from that fresh snapshot.
node ~/.config/herdr-app/mods/devices/agent.mjs run current click @e1 --snapshot --compact
node ~/.config/herdr-app/mods/devices/agent.mjs close current
```

The reported machine's raw `idb ui tap` failed with
`The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated`
even after reboot (idb-companion 1.7.8). It was not a working fallback.

## Verification record

Target: iPhone 17 simulator `84E2517A-8EDB-4164-9B14-A401EF92764B`, iOS 26.5,
reported Xcode 27.2, app `com.cmv.chaching.dev`. No app-repository changes.
Fresh helper inspection/input and real viewer pointer input reached Earnings;
the final viewer proof showed Home's `Shop & Get Cashback`, then Earnings'
`Cashback In`, with painted frames increasing from 65 to 128.

Evidence is local to Khairul's machine, outside the repository:
`/Users/khairul/.local/share/herdr-app/stream-fix-20261118/`.

| File | What it establishes |
| --- | --- |
| `input-proof.json`, `input-earnings.png` | Actual viewer input and resulting Earnings content with advancing video. |
| `headless-boot-proof.json`, `headless-cold-boot.png` | Private cold simulator boot via simctl, decoded frames, no GUI launcher attempts or window increase. Private simulator was deleted. |
| `recovery-proof.json` | Paused transport and killed capture-child recovery at the stable proxy origin. |
| `unresponsive-proof.json` | SIGSTOP without manual resume: replacement PID, retained-frame overlay, resumed paints, three successful snapshots while video advances. |
| `native-webview-proof.json` | Earlier actual Herdr WKWebView paint and reconnect proof. Later hidden-view attempt in `native-last-run.json` failed to establish recovery; it does not supersede the good proof or establish final native coverage. |
| `verified-final-suite.log` | 227 JavaScript tests, 500 Rust unit tests, plus integration checks passed; documented ignored tests remain. |
| `verified-release-build.log`, `installation-proof.json` | Release build, signed installation, hashes and rollback location. |

Final full-suite command used toolchain 1.95.0, serial Rust tests and a fresh
private temporary directory:

```sh
env RUSTUP_TOOLCHAIN=1.95.0 RUST_TEST_THREADS=1 TMPDIR=/private/tmp/herdr-device-final-6u1p03wc/ just test
env RUSTUP_TOOLCHAIN=1.95.0 cargo build --release --locked
git diff --check
```

Create a new private TMPDIR for a new run. An earlier default parallel run hit
unrelated existing temporary-fixture permissions and launchctl timing failures;
`full-tests.log` retains that failure. Do not cite it as passing. Focused tests:
`bun test scripts/devices.test.ts scripts/devices-interaction.test.ts scripts/devices-live.test.ts`.
Unit tests alone cannot establish headless startup or continuous native video.

The installed signed executable is
`/Users/khairul/Applications/Herdr.app/Contents/MacOS/Herdr`, CLI version 0.1.15,
SHA256 `0fd38270824ae406e6665ff77ce282f181d6ef19c55b92a8293e6271c2fd58c4`.
Strict signature verification passed, and a tampered scratch bundle was rejected.
Verified rollback bundles are under `bundle/20261118-212316/` in the evidence
directory (`Herdr.previous.app`, `Herdr.replaced.app`). The reopened running
process was subsequently verified to map the installed executable inode.
Core was not replaced or restarted.

After verification, at the user's request, the helper session was disconnected,
the simulator shut down and DeviceHub quit. The reporting agent `t9n5` received
the findings and reopen instructions. Tests/fixes remain uncommitted; no release,
push or merge was performed. These are historical facts; recheck live state.

# SUPERCRZY BOT · Android shell

P0 of the Android app: a WebView shell that hosts the existing Vue client and adds
the native bridges a browser cannot provide. No Compose, no AppCompat — the shell
is meant to stay small and boring so the Web UI remains the single source of truth.

## What works now

- WebView pointing at the runtime **on this phone** (`http://127.0.0.1:3000`) by default —
  the chroot BOT install already listens there, so a fresh shell is usable immediately
- Settings can repoint the same shell at a desktop on the LAN (`settings → server address`)
- Back key routed through WebView history
- File chooser (attachments, camera) via SAF
- Downloads land in `Downloads/` through `DownloadManager`
- Notifications (task updates from the page via `window.SuperCrzy.notify`)
- Foreground service anchor for the runtime that lands in P1
- `window.SuperCrzy.getCapabilities()` → `{sdk, accessibility, wirelessDebug}`

Not in this build: the on-device runtime (PRoot + Node), screen control (P3),
in-app update (P5). The service and service config are declared and inert.

## Build locally (optional)

CI does this for you; these steps are for iterating with a device attached.

```bash
brew install --cask temurin@17 gradle        # one-off
export ANDROID_HOME=~/Library/Android/sdk
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

cd apps/android
gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or, after one `gradle wrapper` (generates the wrapper jar), use `./gradlew`.

## Build in CI

`Build Android` workflow → manual dispatch, or push a `v*` tag. Artifacts:
`supercrzy-bot-android-<version>/app-debug.apk` (installable) and
`app-release.apk` (debug-signed until keystore secrets are configured).

## Pointing the shell at a server

Default: the runtime on the phone itself (`127.0.0.1:3000`). Nothing to configure.

To drive a desktop instead, the desktop server must listen on the LAN, not just loopback:

```bash
HOST=0.0.0.0 pnpm --filter @supercrzy/server start
```

Then enter `192.168.x.x` in settings (the `:3000` port is added automatically if you
omit it). Same Wi-Fi as the phone. "Use this phone" in the dialog clears the override.

## Layout

```
app/src/main/java/com/supercrzy/bot/
  MainActivity.kt              WebView host + bridges + settings + error surface
  Notifications.kt             channels + posting (permission-aware)
  BotRuntimeService.kt         foreground anchor; P1 starts the runtime here
  BotAccessibilityService.kt   P3 screen reading; declared and inert for now
app/src/main/res/xml/
  network_security_config.xml  cleartext allowed (LAN HTTP by design)
  accessibility_service_config.xml  capabilities for P3
```

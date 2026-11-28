#!/bin/bash
# Builds the RoboDinghy helper APK (guest-android/build/robodinghy-helper.apk)
# with the installed Android SDK: javac -> d8 -> aapt2 -> zipalign -> apksigner.
# No Gradle, no Kotlin. One command from a clean checkout:
#   guest-android/build.sh
# Overrides: ANDROID_HOME / ANDROID_SDK_ROOT, BUILD_TOOLS (e.g. 34.0.0),
# PLATFORM (e.g. android-34), JAVA_HOME.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
APK="$OUT/robodinghy-helper.apk"

die() { echo "Error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# --- SDK ---------------------------------------------------------------
SDK=""
for c in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
         /opt/homebrew/share/android-commandlinetools \
         "$HOME/Library/Android/sdk" \
         "$HOME/Library/Application Support/RoboDinghy/sdk"; do
  if [ -n "$c" ] && [ -d "$c/platforms" ] && [ -d "$c/build-tools" ]; then SDK="$c"; break; fi
done
[ -n "$SDK" ] || die "Android SDK not found (set ANDROID_HOME; needs platforms/ and build-tools/)"

PLATFORM="${PLATFORM:-}"
if [ -z "$PLATFORM" ]; then
  if [ -f "$SDK/platforms/android-34/android.jar" ]; then PLATFORM=android-34
  else PLATFORM="$(ls "$SDK/platforms" 2>/dev/null | grep -E '^android-[0-9]+$' | sort -t- -k2 -n | tail -1 || true)"
  fi
fi
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"
[ -n "$PLATFORM" ] && [ -f "$ANDROID_JAR" ] || die "no platforms/android-<N>/android.jar in $SDK (sdkmanager \"platforms;android-34\")"

BUILD_TOOLS="${BUILD_TOOLS:-}"
if [ -z "$BUILD_TOOLS" ]; then
  if [ -x "$SDK/build-tools/34.0.0/aapt2" ]; then BUILD_TOOLS=34.0.0
  else BUILD_TOOLS="$(ls "$SDK/build-tools" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1 || true)"
  fi
fi
BT="$SDK/build-tools/$BUILD_TOOLS"
[ -n "$BUILD_TOOLS" ] && [ -d "$BT" ] || die "no build-tools in $SDK (sdkmanager \"build-tools;34.0.0\")"
for t in d8 aapt2 zipalign apksigner; do
  [ -x "$BT/$t" ] || die "missing $BT/$t"
done

# --- JDK ---------------------------------------------------------------
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/javac" ]; then
  JAVA_HOME=""
  for c in /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home \
           /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
           /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
    [ -x "$c/bin/javac" ] && { JAVA_HOME="$c"; break; }
  done
  if [ -z "$JAVA_HOME" ] && [ -x /usr/libexec/java_home ]; then
    JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || true)"
  fi
fi
[ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/javac" ] || die "JDK 17+ not found (brew install openjdk, or set JAVA_HOME)"
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
command -v zip >/dev/null || die "zip not found"
for t in javac keytool; do
  [ -x "$JAVA_HOME/bin/$t" ] || die "missing $JAVA_HOME/bin/$t"
done

say "SDK $SDK (platform $PLATFORM, build-tools $BUILD_TOOLS), JDK $JAVA_HOME"

# --- build -------------------------------------------------------------
rm -rf "$OUT/classes" "$OUT/dex" "$OUT/sources.txt" "$OUT/classes.txt" "$OUT/res" "$OUT"/*.unsigned.apk "$OUT"/*.aligned.apk "$APK" "$APK.idsig"
mkdir -p "$OUT/classes" "$OUT/dex"

say "Compiling Java"
# Paths go through NUL-delimited bash arrays (not an @argfile or $(cat ...)),
# so a checkout path containing spaces or other whitespace stays one argument.
SOURCES=()
while IFS= read -r -d '' f; do SOURCES+=("$f"); done < <(find "$HERE/src" -name '*.java' -print0)
[ "${#SOURCES[@]}" -gt 0 ] || die "no Java sources under $HERE/src"
"$JAVA_HOME/bin/javac" --release 17 -encoding UTF-8 -Xlint:-options -nowarn \
  -classpath "$ANDROID_JAR" -d "$OUT/classes" "${SOURCES[@]}"

say "Dexing"
CLASSES=()
while IFS= read -r -d '' f; do CLASSES+=("$f"); done < <(find "$OUT/classes" -name '*.class' -print0)
[ "${#CLASSES[@]}" -gt 0 ] || die "javac produced no class files"
"$BT/d8" --release --min-api 30 --lib "$ANDROID_JAR" --output "$OUT/dex" "${CLASSES[@]}"
[ -f "$OUT/dex/classes.dex" ] || die "d8 produced no classes.dex"

say "Packaging"
"$BT/aapt2" link -o "$OUT/helper.unsigned.apk" -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" --min-sdk-version 30 --target-sdk-version 34
(cd "$OUT/dex" && zip -q -X "$OUT/helper.unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/helper.unsigned.apk" "$OUT/helper.aligned.apk"

KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  say "Generating debug keystore (once)"
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias robodinghy -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=RoboDinghy Debug,O=RoboDinghy" >/dev/null 2>&1 || die "keytool failed"
fi

# JDK 24+ warns about conscrypt's native access inside apksigner; drop that noise only.
quiet_jdk() { "$@" 2> >(grep -v -E '^WARNING: (A restricted method|java\.lang\.System::loadLibrary|Use --enable-native-access|Restricted methods will)' | grep -v '^$' >&2); }

say "Signing"
quiet_jdk "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias robodinghy --out "$APK" "$OUT/helper.aligned.apk"
quiet_jdk "$BT/apksigner" verify "$APK" || die "apksigner verify failed"
rm -f "$OUT/helper.unsigned.apk" "$OUT/helper.aligned.apk" "$APK.idsig"

say "Built $APK"

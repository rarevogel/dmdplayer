#!/bin/sh
# Builds DMDPlayer.apk without Gradle: aapt (R.java) -> javac -> dx -> aapt -> zipalign -> apksigner
# Needs: android-sdk platform android-23 (android.jar), aapt, dalvik-exchange (dx), zipalign, apksigner, JDK.
set -e
cd "$(dirname "$0")"
python3 ../build.py                       # refreshes assets/index.html from src/
SDK=/usr/lib/android-sdk/platforms/android-23/android.jar
rm -rf build && mkdir -p build/classes build/apk build/gen
aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$SDK"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$SDK" -Xlint:-options -d build/classes \
    $(find src -name "*.java") build/gen/nl/rarevogel/dmdspeler/R.java
dalvik-exchange --dex --output=build/apk/classes.dex build/classes
aapt package -f -0 arsc -0 png -0 woff2 -M AndroidManifest.xml -S res -A assets -I "$SDK" -F build/unsigned.apk
(cd build/apk && aapt add ../unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 build/unsigned.apk build/aligned.apk
[ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android \
    -alias dmdspeler -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=DMD Speler" >/dev/null 2>&1
apksigner sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
    --out DMDPlayer.apk build/aligned.apk
apksigner verify DMDPlayer.apk && ls -la DMDPlayer.apk

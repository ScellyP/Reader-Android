# Making APK updates work

Android accepts an APK as an update only when the **applicationId**, signing certificate, and a higher **versionCode** all match the installed app.

This project uses `com.scell.novelreader.redesign`. **No signing key is stored in the repository.** The key lives only in four GitHub secrets, and `.github/workflows/build-apk.yml` decodes it at build time.

## One-time setup: create your signing key

Run this on your own computer (needs a JDK; `keytool` ships with it). Pick your own passwords and keep the file somewhere private and backed up. If you lose it, you can never publish an update over the installed app again.

```
keytool -genkeypair -v -keystore novelreader-signing.keystore \
  -alias novelreader -keyalg RSA -keysize 2048 -validity 10000
```

Turn the keystore into a single line of text for GitHub:

```
base64 -w0 novelreader-signing.keystore        # Linux
base64 -i novelreader-signing.keystore         # macOS
```

## GitHub signing secrets

In the repository: **Settings → Secrets and variables → Actions → New repository secret**. Add all four:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the base64 text from above |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password you chose |
| `ANDROID_KEY_ALIAS` | `novelreader` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the key password you chose |

Never commit the `.keystore` file (`.gitignore` blocks `*.keystore` and `*.jks`).

## If the secrets are missing

The workflow prints a warning and the build falls back to Android's default debug key. That APK installs, but it **cannot update** an app that was installed from a build signed with your real key (and the reverse), so you would have to uninstall first. Builds made in Android Studio on a computer behave the same way.

## Important: the old key is compromised

Earlier versions of this project shipped two keystores together with their password (`novelreader`). Anyone who ever had those files can sign an APK that Android would accept as an update to an app signed with them. Do not reuse that key.

- Create a fresh key as above; do **not** put the old keystore into the secrets.
- Because the new key differs from the old one, uninstall the currently installed app once and install the new APK. Settings are restored from `Novel/settings.txt`. After that, every later APK signed with the new key updates in place.
- If an earlier version was already uploaded to GitHub, the old keystores still exist in that repository's history. Delete and recreate the repository (or rewrite its history) after you add the secrets.

## Versioning

Every GitHub Actions run gets a higher `versionCode` automatically (the run number), so each build can install over the previous one as long as the signing key stays the same.

The generated APK is `app-debug.apk` for now (artifact `novel-reader-debug-apk`).

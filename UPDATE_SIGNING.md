# Making APK updates work

Android accepts an APK as an update only when the **applicationId**, signing certificate, and a higher **versionCode** all match the installed app.

This project uses `com.scell.novelreader.redesign` and a persistent release keystore. The first APK produced by this patched workflow uses the same repository keystore on every build unless all four GitHub signing secrets are configured.

## Important: existing APK

If the APK currently installed on the phone was signed by a different key (for example, an old GitHub Actions debug APK), the new release **cannot** update it. APKs do not contain the private signing key needed to reproduce their certificate.

In that case, install this patched APK once after uninstalling the old app. From then on, future APKs from this project can update it normally.

## GitHub signing secrets (recommended)

For a private repository, you can replace the repository keystore with your own protected signing key by adding:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

When those secrets are present, the workflow automatically uses them instead of the repository fallback key.

## Versioning

For every update, increase `versionCode` (2, 3, 4, ...). Keep the same signing key. Start the workflow manually and enter the next versionCode/versionName.

The generated APK is `app-release.apk`.

# Code signing and release integrity policy

Trusted signing, when enabled, is provided by SignPath.io with a certificate by SignPath Foundation.

## Scope

Only Windows release installers built from this public repository by the protected GitHub Actions release workflow are eligible for publication. The workflow verifies the exact release commit, requires the full CI suite to pass, binds the Tauri updater signature to the exact installer, verifies its SHA-256 digest, smoke-tests the packaged application, and publishes the completed draft atomically.

When `SIGNPATH_ENABLED=true`, the workflow additionally submits the GitHub-hosted artifact to SignPath, requires a valid returned Authenticode signature, and regenerates the Tauri updater signature against that signed installer before publication. This is the preferred production path.

When SignPath production provisioning is unavailable, `SIGNPATH_ENABLED=false` selects an explicit unsigned fallback. The same CI, exact-SHA, updater-signature, digest, packaged-smoke, manifest, and atomic-publication gates remain mandatory, but Windows may display `Publisher: Unknown` or a SmartScreen warning. Switching the variable to `true` automatically restores the trusted Authenticode path without another workflow change.

## Team roles

- Committer and reviewer: [Ramdan](https://github.com/mramdann)
- Signing approver: [Ramdan](https://github.com/mramdann)

## Privacy

Anbo has no telemetry. Its network-capable features and locally stored data are documented in the [privacy policy](PRIVACY.md). Network requests occur for features selected by the user, browser activity, agent or provider integrations, Git operations, and update checks against this repository.

## Verification

On Windows, open the installer's Properties dialog and inspect Digital Signatures, or run:

```powershell
Get-AuthenticodeSignature .\Anbo_*_x64-setup.exe |
  Select-Object Status, StatusMessage, SignerCertificate
```

For a SignPath release, the status must be `Valid`. For an explicitly unsigned fallback, `NotSigned` is expected. In both modes the release workflow verifies the SHA-256 digest and Tauri updater signature metadata again immediately before making the draft public.

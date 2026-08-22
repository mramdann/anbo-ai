# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Scope

Only Windows release installers built from this public repository by the protected GitHub Actions release workflow are eligible for production signing. The workflow verifies the exact release commit, requires the full CI suite to pass, submits the GitHub-hosted build artifact to SignPath, verifies the returned Authenticode signature, and binds the Tauri updater signature to that exact signed installer before publication.

Unsigned production installers must not be published. Historical releases created before this policy may be unsigned.

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

The status must be `Valid`. The release workflow also verifies the SHA-256 digest of the signed installer again immediately before making the draft public.

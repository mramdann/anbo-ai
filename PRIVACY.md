# Privacy policy

Anbo is a local desktop development workspace. It has no Anbo account, advertising, analytics, or telemetry, and it does not sell or share personal information.

## Network communication

Anbo transfers information to a networked system only for the following user-visible purposes:

- The updater periodically retrieves public release metadata from `github.com/mramdann/anbo-ai`. Installing an update requires the user's confirmation.
- Browser tabs load the addresses the user or an explicitly invoked browser-automation action requests.
- AI prompts, selected files, and tool results are sent only to the AI provider or local endpoint configured and invoked by the user. Those services have their own privacy policies.
- CLI agents and source-control commands may access services configured and invoked by the user, such as an AI provider or Git remote.
- Anbo's MCP automation endpoint listens on loopback only and does not accept remote network connections.

Anbo does not transmit workspace contents, prompts, terminal output, or usage information to the Anbo maintainer.

## Local data

Workspace layout, settings, browser profile data, terminal/session metadata, and editor state remain on the device. Provider credentials are stored through the operating-system keychain. Removing Anbo does not delete user projects.

## Contact

Privacy or security questions can be reported privately through [GitHub private vulnerability reporting](https://github.com/mramdann/anbo-ai/security/advisories/new).

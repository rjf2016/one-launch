# Security

## Reporting a vulnerability

Report it privately: on this repository's Security tab choose "Report a vulnerability", or go to <https://github.com/rjf2016/one-launch/security/advisories/new>. Please do not open a public issue for it.

Include the One Launch version (bottom of the sidebar), your Windows version, the launcher involved, and the steps. Read any log or screenshot before you attach it: logs redact passwords, tokens, emails and account ids, but they contain file paths and game names.

## Supported versions

Only the latest release gets fixes. A copy installed with "Only for me" updates itself.

## What One Launch defends

One Launch keeps launcher sign-ins and optional passwords, encrypted with Windows DPAPI for the current Windows user, and rewrites launcher files and registry values to switch accounts. Reports of these kinds matter most:

- a stored secret reaching another Windows user, the network, the logs, or the interface when it should not;
- an update or installer running that the project's release key did not sign;
- content in launcher files, artwork, or the update feed running code or changing files it should not.

Another program already running as the same Windows user can read whatever One Launch can. That is outside what it defends against.

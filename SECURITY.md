# Security policy

## Supported versions

The latest published minor release receives security fixes. Release candidates
are supported until the corresponding stable release.

| Version | Supported |
| --- | --- |
| 0.3.x | yes |
| < 0.3 | no |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

1. Open <https://github.com/khurrambhutto/classmcp/security/advisories/new>.
2. Describe the issue, affected version, and reproduction steps. Do not include
   real credentials, tokens, or other people's data.
3. Expect an acknowledgement within a few days. Please do not open a public
   issue before a fix is available.

## Scope and threat model

classmcp runs locally over stdio and acts as the signed-in student. The most
interesting areas for reports are:

- Escaping the allowed file roots (`~/Downloads`, `$CLASSMCP_WORKDIR`) through
  symlinks, path traversal, filename tricks, or race conditions.
- Reading or writing files outside the documented download behavior.
- Leaking credentials, tokens, or file contents into transcripts, logs,
  `structuredContent`, or error messages.
- Turning in or modifying submissions after a failed or unrequested step.
- OAuth callback handling (state, redirect, listener lifecycle).

Out of scope:

- Google's `403 @ProjectPermissionDenied` restriction on third-party
  submission writes (documented limitation, not a classmcp vulnerability).
- Host applications rendering tool output they requested.
- Attacks that require an already-compromised local account or filesystem.

## Handling secrets

- Never paste client secrets or tokens into issues, PRs, or transcripts.
- Run `classmcp doctor` before sharing diagnostics; it reports status without
  printing secrets.
- If a credential leaks, revoke it in Google Cloud Console and rerun
  `classmcp setup`; delete `~/.classmcp` if a token leaked.

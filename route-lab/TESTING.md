# Testing

Use Node.js 24 or newer. No npm dependencies are required:

```sh
npm test
```

The suite covers the UDP lab, public/private profile boundaries, configuration generation/rejection, manager recovery using mocked Windows helpers, HTTP controls, JavaScript source syntax and Linux relay plan parsing. Network tests use owned loopback echo endpoints. Linux relay tests need GNU Bash; on Windows use Git Bash or set `ROUTELAB_BASH` to its full executable path. Bash-dependent tests are skipped if Bash is unavailable.

For Windows policy tests:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Test-TunnelValidation.ps1
```

These checks validate policy and syntax without installing WireGuard, activating a tunnel or applying Linux firewall changes. Manager helper mocks are not live Windows integration tests.

The original development baseline on 20 October 2026 passed 44 Node tests and 21 Windows policy checks. Live Windows tunnel activation, public relay handshake, Linux apply/remove/rollback and actual game performance remain unverified. Browser visual layout was not inspected automatically.

The demo test writes a local `demo-validation.json`; it is ignored by Git. Keep generated reports, logs, captures and private configurations out of commits.

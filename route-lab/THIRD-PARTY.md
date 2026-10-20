# External projects

RouteLab invokes external tools installed separately. Their code and binaries are not vendored here.

- [Node.js](https://nodejs.org/) supplies the JavaScript runtime and standard libraries.
- [WireGuard](https://www.wireguard.com/) supplies the Windows tunnel implementation and Linux WireGuard tools.
- Windows PowerShell and Windows networking facilities supply local management APIs.
- GNU Bash, iproute2, iptables, procps and system utilities are relay/test prerequisites as documented in the relay README.

Each external project retains its own license and terms. RouteLab does not claim ownership of those projects or affiliation with their maintainers.

The implementation contains no ExitLag executable, driver, proprietary source, wire protocol or vendor relay access. It is an independent prototype and does not claim compatibility or equivalent algorithms.

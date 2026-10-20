# External WireGuard tools

WireGuard binaries/installers are not included in this repository. For normal setup, install [official WireGuard for Windows](https://www.wireguard.com/install/) and let RouteLab detect its signed executables under Program Files.

The optional managed installer is pinned to WireGuard AMD64 **1.1.1**. To use it, download this official file into this directory:

[wireguard-amd64-1.1.1.msi](https://download.wireguard.com/windows-client/wireguard-amd64-1.1.1.msi)

Expected SHA-256:

```text
7BFED60AD61B785C914B38B61555A975488E1D3EC472DBFB2FCDF498FCA75242
```

The installer helper requires both that hash and a valid WireGuard LLC Authenticode signature before requesting MSI installation. It does not activate a tunnel or reboot automatically. The install path is AMD64-specific; other architectures need a separately reviewed package and integration update.

The MSI is ignored by Git. Do not add vendor binaries or drivers to this source repository. If the pinned release becomes unavailable, review an official replacement and update its URL, hash, signature expectations and tests together.
